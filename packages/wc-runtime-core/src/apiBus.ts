// 全局单例 apiBus：**唯一的数据上报通道**，且必须由调用方（宿主 / 页面）**显式**调用。
//
// 设计原则（重要）：
// - runtime **不自动采集任何数据**（不拦 fetch / XHR，不监听请求）。想看什么，调用方自己 report 一次。
// - 没人调用 = 没有任何数据出浏览器（天然 fail-closed，不需要维护白名单）。
// - 报什么由调用方决定：`data` 是调用方已经确定要给 agent 看的内容，runtime 只补 `page` / `at`
//   并施加体积硬上限，**不做**业务过滤 / 脱敏（需要脱敏请在调用点做）。
//
// 为什么用 Symbol.for + globalThis：
// demo-app 的页面 bundle 与 chat-client 的 wc-runtime-core 是两个模块副本（各自打包），
// 模块级 let 会各持一份导致 report/attach 跨 bundle 失联。挂到全局只有一个真相源。
export interface ApiReport {
  /** 调用方已经确定要给 agent 看的数据（脱敏责任在调用方） */
  data: unknown
  /**
   * 数据来源标识（调用方自己起名，如 `'user-list'`）。
   * 会出现在 agent prompt 的「来源：…」处；缺省回退到 `url`。
   */
  source?: string
  /**
   * 原始请求 URL（**可选**）：给了才能命中 manifest `dataSources` 做「可选的额外裁剪」；
   * 不给（比如宿主报一份自己算出来的数据）就直接透传 `data`。
   */
  url?: string
  /** HTTP 方法（可选，仅作上下文） */
  method?: string
  /** 产生数据的页面 tag（runtime 自动补） */
  page?: string
}

type ApiBusListener = (payload: ApiReport) => void

const GLOBAL_KEY = 'webassistant.apiBus'

interface ApiBusState {
  listener: ApiBusListener | null
}

function getState(): ApiBusState {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { listener: null } satisfies ApiBusState
  }
  return g[GLOBAL_KEY] as ApiBusState
}

export const apiBus = {
  /**
   * 调用方显式上报一次数据（宿主 / 页面都可以调）。
   *
   * 返回 `true` = 有 runtime 在监听（数据已进入 page-data 事件）；
   * 返回 `false` = 无人监听（静默丢弃，例如同一个页面在「没有挂 assistant 的 SPA」里跑）。
   * 返回值的用途是让调用方在开发期自检「上报有没有生效」，不必改变正常流程。
   */
  report(payload: ApiReport): boolean {
    const listener = getState().listener
    if (!listener) return false
    listener(payload)
    return true
  },
  /** runtime 注册 sink：接收所有 report。返回 detach 函数。 */
  attach(sink: ApiBusListener): () => void {
    const state = getState()
    // 单 sink 语义：新 attach 会顶掉旧的。旧 sink 还活着却要覆盖它，几乎一定是 bug
    // （典型：宿主/页面自己调了 attach，把内核的 sink 顶掉 → 上报全丢且无任何提示）。
    if (state.listener && state.listener !== sink) {
      console.warn(
        '[wc-runtime-core] apiBus.attach 覆盖了已存在的 sink —— 同页只应有一个消费者（runtime 内核）。' +
          '业务侧想做「把数据交给 agent」这件事，请调用 report()，不要 attach()。',
      )
    }
    state.listener = sink
    return () => {
      if (state.listener === sink) state.listener = null
    }
  },
  /** 是否有订阅者（API 设计：让调用方知道上报是否被监听） */
  get attached(): boolean { return getState().listener !== null },
}

