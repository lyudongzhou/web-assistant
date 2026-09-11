// 全局单例 apiBus：页面手动调 report() → sink（runtime 注册）→ 按 dataSources 摘要 → page-data 事件。
// 设计约束：页面不感知 agent/WebSocket；bus 只是数据上报通道。
//
// 为什么用 Symbol.for + globalThis：
// demo-app 的页面 bundle 与 chat-client 的 wc-runtime-core 是两个模块副本（各自打包），
// 模块级 let 会各持一份导致 report/attach 跨 bundle 失联。挂到全局只有一个真相源。
export interface ApiReport {
  /** 原始请求 URL */
  url: string
  /** HTTP 方法（缺省 GET） */
  method?: string
  /** 原始响应数据（由调用方提供，通常是 apiBus.report() 时传入） */
  data: unknown
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
  /** 页面 / 拦截器调用：上报接口数据。没有 attach 时静默丢弃。 */
  report(payload: ApiReport): void {
    getState().listener?.(payload)
  },
  /** runtime 注册 sink：接收所有 report。返回 detach 函数。 */
  attach(sink: ApiBusListener): () => void {
    const state = getState()
    state.listener = sink
    return () => {
      if (state.listener === sink) state.listener = null
    }
  },
  /** 是否有订阅者（API 设计：让调用方知道上报是否被监听） */
  get attached(): boolean { return getState().listener !== null },
}
