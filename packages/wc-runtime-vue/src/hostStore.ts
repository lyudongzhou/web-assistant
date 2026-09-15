// 宿主 store → CE 的快照桥（宿主侧）。
//
// 为什么不是「宿主和 CE 共用同一个 pinia 实例」：
//   宿主与批次是两份 **vue 副本**（容器 bundle 自带一份 vue，见 PROJECT.md「依赖两层」），
//   pinia 的 $state 里的 ref/computed 由「创建它的那份副本」的响应式系统实现，依赖收集靠模块级
//   activeSub，跨副本不互通 —— 把宿主 store 实例直接给页面，表现是「首次能读、之后不更新」。
//   真要共用同一个实例，前提是连 vue 一起共享（CE 构建 external + 宿主 import map），代价是页面
//   bundle 不再自包含。详见 docs/INTEGRATION_GUIDE.md「宿主 store 里的数据怎么进 CE」。
//
// 所以统一走：宿主监听 → 推**纯数据快照** → CE 侧自己的 pinia 里 hydrate（镜像）。
//
// 本文件**不 import vue / pinia**（只用结构类型），因此可以从宿主入口
// `@webassistant/wc-runtime-vue/host` 导出，宿主不会因此把 vue 打进自己的产物。
//
// 宿主用法（pinia 插件方式，自动覆盖之后创建的所有 store）：
// ```ts
// const pusher = createHostStorePusher({ getRuntime: () => runtime })
// hostPinia.use(pusher.plugin)
// ```
// 没有宿主 app（pinia 插件不生效）或只想桥某几个 store 时，用 `pusher.push(store)`。

/** 宿主 pinia 的每个 store 在 state 桥里占一个 key：`store:auth` */
export const HOST_STORE_KEY_PREFIX = 'store:'

/** CE 侧回传 store 变更的事件名（镜像的 twoWay 模式用） */
export const STORE_PATCH_EVENT = 'store-patch'

export function hostStoreKey(id: string): string {
  return `${HOST_STORE_KEY_PREFIX}${id}`
}

export function isHostStoreKey(key: string): boolean {
  return key.startsWith(HOST_STORE_KEY_PREFIX)
}

/** `store:auth` → `auth`；不是 store key 时返回 null */
export function hostStoreIdFromKey(key: string): string | null {
  return isHostStoreKey(key) ? key.slice(HOST_STORE_KEY_PREFIX.length) : null
}

/**
 * pinia store 的公开面。刻意用宽松签名：这里只做**结构对接**，
 * 不 import pinia（保住 wc-runtime-vue 的 peer 依赖只有 vue / vue-router），
 * 也不强迫宿主的 store 类型满足自造的精确签名（pinia 的 `_DeepPartial` 等泛型会互相打架）。
 *
 * 只用到 4 个公开成员：`$id` / `$state` / `$patch` / `$subscribe`（都是 pinia 文档 API，不碰 `_s` 等内部）。
 * `$state` 用 `object` 而不是 `Record<string, unknown>`：具体 store 的类型没有索引签名，
 * 而 TS 只在「对象字面量类型」上给隐式索引签名 —— 用 `object` 才不会让宿主的 store 赋不进来。
 */
export interface HostStoreLike {
  $id: string
  $state: object
  $patch(partial: Record<string, unknown>): unknown
  $subscribe(listener: () => void): () => void
  $dispose?(): void
}

export interface HostPiniaLike {
  use(plugin: (context: { store: HostStoreLike }) => unknown): unknown
}

/** 只用到 setState 的 runtime 面（core 的 Runtime 天然满足） */
export interface HostRuntimeLike {
  setState(patch: Record<string, unknown>): void
}

/**
 * 快照克隆。每次推送必须是**新对象**，原因两条：
 * 1) core 的 state 桥用 `Object.is` 判等（wc-runtime-core/src/state.ts）——
 *    推同一个引用会被当成「没变化」，不通知，页面不动；
 * 2) 与 CE 侧共享嵌套引用时，「宿主原地改嵌套字段」在页面侧读得到新值却不触发渲染
 *    （容器只对 state 顶层做 shallowReactive）。
 * 纯数据（plain object / array / Date）深拷贝；Map / Set / class 实例 / 函数按引用传（边界见文档）。
 */
export function cloneHostState<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (value === null || typeof value !== 'object') return value
  const source = value as unknown as object
  if (seen.has(source)) return seen.get(source) as T
  if (source instanceof Date) return new Date(source.getTime()) as unknown as T
  if (Array.isArray(source)) {
    const out: unknown[] = []
    seen.set(source, out)
    for (const item of source) out.push(cloneHostState(item, seen))
    return out as unknown as T
  }
  if (Object.prototype.toString.call(source) === '[object Object]') {
    const out: Record<string, unknown> = {}
    seen.set(source, out)
    for (const [key, item] of Object.entries(source)) out[key] = cloneHostState(item, seen)
    return out as unknown as T
  }
  return source as T
}

export interface StorePusher {
  /** 交给 `hostPinia.use(pusher.plugin)`：之后创建的每个 store 自动推一次 + 自动订阅变更 */
  plugin: (context: { store: HostStoreLike }) => void
  /**
   * 手动桥接一个 store：装变更订阅（只装一次）并**立刻推一次快照**（每次都推，供 runtime 就绪后补推）。
   * 适用：宿主没把 pinia 装到 app 上（pinia 插件不会生效 —— 插件要 pending 到 install 才移入 `_p`）、
   * 或只想桥某几个 store。
   */
  push(store: HostStoreLike): void
  /** 解绑所有订阅（store 自身的 $dispose 也会自动解绑） */
  dispose(): void
}

/**
 * 宿主侧推手。配合 CE 侧 `createStoreMirror()` 使用：
 * 每个 store 的 `$state` 会被推成 state 桥里的 `store:<id>` 快照。
 */
export function createHostStorePusher(options: {
  /** 懒取 runtime（宿主首屏可能还没 init 完；每次推送现取，避免拿到过期引用） */
  getRuntime: () => HostRuntimeLike | null | undefined
  /** 只桥接这些 store id（缺省全部） */
  only?: readonly string[]
}): StorePusher {
  const only = options.only ? new Set(options.only) : null
  const wired = new Map<HostStoreLike, () => void>()

  const emit = (store: HostStoreLike): void => {
    // 读 $state 会经过 reactive 代理，但订阅回调不在 effect 里执行，不会误收集依赖；
    // 克隆保证「新对象 + 不共享嵌套引用」，见 cloneHostState 的说明。
    options.getRuntime()?.setState({ [hostStoreKey(store.$id)]: cloneHostState(store.$state) })
  }

  function wire(store: HostStoreLike): void {
    if (wired.has(store)) return
    const stop = store.$subscribe(() => emit(store))
    wired.set(store, stop)
    // pinia 不会替插件清理订阅：store 销毁时自己解绑
    const originalDispose = typeof store.$dispose === 'function' ? store.$dispose.bind(store) : null
    if (originalDispose) {
      store.$dispose = () => {
        stop()
        wired.delete(store)
        originalDispose()
      }
    }
  }

  const push = (store: HostStoreLike): void => {
    if (only && !only.has(store.$id)) return
    wire(store)
    emit(store)
  }

  return {
    plugin({ store }) {
      push(store)
    },
    push,
    dispose() {
      for (const stop of wired.values()) stop()
      wired.clear()
    },
  }
}

/**
 * CE 侧 `createStoreMirror({ twoWay: true })` 推回来的 patch → 应用到宿主 store。
 * 宿主在 `services.emit` 里一行接上：
 * ```ts
 * emit: (event, payload) => { if (event === STORE_PATCH_EVENT) applyHostStorePatch(auth, payload) }
 * ```
 * 返回是否真的应用了（id 不匹配 / 载荷不合法 → false）。
 */
export function applyHostStorePatch(store: HostStoreLike, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const id = (payload as { id?: unknown }).id
  const patch = (payload as { patch?: unknown }).patch
  if (id !== undefined && id !== store.$id) return false
  if (!patch || typeof patch !== 'object') return false
  store.$patch(cloneHostState(patch) as Record<string, unknown>)
  return true
}
