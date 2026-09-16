// 全局单例「活动总线」：把「WC 实际执行了什么」汇成一条可订阅的时间线（环形缓冲）。
//
// 谁上报什么：
//   - wc-runtime-vue 的 `getPageExposed` 包裹层 → `kind:'call'`（方法真被调用了：参数 / 耗时 / 结果 / 错误）
//     它覆盖**任何**经 `runtime.getPageExposed()` 的调用者（agent 的 call_page_method、宿主代码直调、工具脚本）
//   - 宿主（chat-client）→ 其余 kind（navigate / emit / data / exposed / network / error），
//     因为这些本来就是 runtime 事件，在宿主处合成最省事（core 不必为观测改动热路径）
//
// 为什么用 Symbol.for + globalThis：容器 bundle 与宿主 bundle 是两份模块副本（同 apiBus.ts 的思路），
// 模块级变量会各持一份，导致「容器上报、宿主订阅」失联；挂到全局才是唯一真相源。
import { sanitizeData } from './sanitize.js'

/** 活动类型：call 是唯一的「执行」；其余是「发生了什么」 */
export type WcActivityKind = 'call' | 'navigate' | 'emit' | 'data' | 'exposed' | 'error'

/** 调用来源：agent（call_page_method）还是宿主/页面自身代码 */
export type WcActivityOrigin = 'agent' | 'host'

export interface WcActivity {
  /** 发生时间（ms epoch） */
  at: number
  kind: WcActivityKind
  /** 页面 tag（页面级活动才有） */
  tag?: string
  /** call: 方法名；emit: 事件名；navigate: 路由 path；data: 数据源；network: 请求方法；error: 摘要 */
  name?: string
  /** 入参：call 是实参数组；emit 是事件载荷；exposed 是 key 列表 */
  args?: unknown
  /** 仅 call：发起方 */
  origin?: WcActivityOrigin
  /** 仅 call：成功与否 */
  ok?: boolean
  /** 仅 call：从进入方法到结算的耗时 */
  durationMs?: number
  /** 仅 call 成功：返回值 */
  result?: unknown
  /** 失败原因（call 抛错 / 被拒绝；error 类的摘要） */
  error?: string
}

/** report() 的入参：at 可省（自动补 now） */
export type WcActivityInput = Omit<WcActivity, 'at'> & { at?: number }

export interface ActivityBus {
  /** 记录一条活动：写环形缓冲 + 通知订阅者（args/result 会做脱敏与截断） */
  report(activity: WcActivityInput): WcActivity
  /** 订阅活动（返回退订函数） */
  on(listener: (activity: WcActivity) => void): () => void
  /** 当前缓冲快照（**最新在前**） */
  snapshot(): WcActivity[]
  /** 清空缓冲（订阅关系不变） */
  clear(): void
  readonly limit: number
  setLimit(limit: number): void
}

/** 单条活动里 args/result 的最大字节数（超出会被截断并留 `...(truncated)` 标记） */
const MAX_VALUE_BYTES = 8 * 1024
/** 单条活动里 args/result 的最大展开层级 */
const MAX_VALUE_DEPTH = 4

interface ActivityState {
  listeners: Set<(activity: WcActivity) => void>
  /** 环形缓冲，**最新在前** */
  buffer: WcActivity[]
  limit: number
  /** 当前调用来源；由 withActivityOrigin 在同步区间内临时改写（跨 bundle 共享） */
  origin: WcActivityOrigin
  /** 已被「执行监视」包裹过的函数（跨 bundle 共享，用于避免宿主重复记账） */
  traced: WeakSet<object>
}

const GLOBAL_KEY = Symbol.for('webassistant.activityBus')
const DEFAULT_LIMIT = 200

function getState(): ActivityState {
  const global = globalThis as unknown as Record<symbol, ActivityState | undefined>
  let state = global[GLOBAL_KEY]
  if (!state) {
    state = { listeners: new Set(), buffer: [], limit: DEFAULT_LIMIT, origin: 'host', traced: new WeakSet() }
    global[GLOBAL_KEY] = state
  }
  return state
}

/**
 * 标记「这个函数已被容器侧包裹过，调用会被 activityBus 自动记账」。
 * 宿主（callPageMethod）据此避免对同一次调用重复上报 —— WeakSet 放在全局状态里，
 * 因此容器 bundle 标记、宿主 bundle 查询也能命中同一个对象。
 */
export function markActivityTraced<T extends object>(value: T): T {
  getState().traced.add(value)
  return value
}

export function isActivityTraced(value: object): boolean {
  return getState().traced.has(value)
}

/** 在给定来源标记下同步执行 run（用于把「agent 发起」标到随后发生的调用上） */
export function withActivityOrigin<T>(origin: WcActivityOrigin, run: () => T): T {
  const state = getState()
  const previous = state.origin
  state.origin = origin
  try {
    return run()
  } finally {
    // 只复位到上一个值：支持嵌套（agent 调页面 → 页面又直调 → 仍是 agent 区间内）
    state.origin = previous
  }
}

/** 当前调用来源（容器包裹层据此区分 agent / 宿主） */
export function currentActivityOrigin(): WcActivityOrigin {
  return getState().origin
}

export const activityBus: ActivityBus = {
  report(input) {
    const state = getState()
    const activity: WcActivity = {
      ...input,
      at: input.at ?? Date.now(),
      args: sanitizeValue(input.args),
      result: sanitizeValue(input.result),
    }
    state.buffer.unshift(activity)
    if (state.buffer.length > state.limit) state.buffer.length = state.limit
    // 复制一份再遍历：允许 listener 内部取消订阅 / 再上报
    for (const listener of [...state.listeners]) {
      try {
        listener(activity)
      } catch (cause) {
        // 观测失败绝不影响业务主流程
        console.warn('[activityBus] listener 抛错：', cause)
      }
    }
    return activity
  },
  on(listener) {
    const state = getState()
    state.listeners.add(listener)
    return () => {
      state.listeners.delete(listener)
    }
  },
  snapshot() {
    return [...getState().buffer]
  },
  clear() {
    getState().buffer.length = 0
  },
  get limit() {
    return getState().limit
  },
  setLimit(limit) {
    const state = getState()
    state.limit = Math.max(1, Math.floor(limit))
    if (state.buffer.length > state.limit) state.buffer.length = state.limit
  },
}

/** 脱敏 + 截断（复用 sanitizeData 的深拷贝实现；truncated 标记会内联进返回值） */
function sanitizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (typeof value !== 'object') return value
  try {
    return sanitizeData(value, MAX_VALUE_BYTES, MAX_VALUE_DEPTH).data
  } catch {
    return '[unserializable]'
  }
}
