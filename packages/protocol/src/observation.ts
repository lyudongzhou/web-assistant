// Runtime → agent 的页面观察契约。
// 业务页面不需要调用这些 API；runtime 负责透明观察请求生命周期并转发事件。

export type NetworkObservationStatus = 'pending' | 'completed' | 'failed' | 'timed_out'

export interface PageObservationContext {
  /** 当前页面标签 */
  page?: string
  /** 产生请求时所在的导航 */
  navigationId?: string
}

export interface PageNetworkRequest extends PageObservationContext {
  type: 'page.network.request'
  requestId: string
  method: string
  url: string
  startedAt: number
}

export interface PageNetworkResponse extends PageObservationContext {
  type: 'page.network.response'
  requestId: string
  method: string
  url: string
  status: number
  ok: boolean
  /** 仅允许 runtime 过滤后的安全数据 */
  data?: unknown
  receivedAt: number
  durationMs: number
  /** response 在 request timeout 之后到达 */
  late?: boolean
}

export interface PageNetworkError extends PageObservationContext {
  type: 'page.network.error'
  requestId: string
  method: string
  url: string
  error: string
  failedAt: number
  durationMs: number
}

export interface PageNetworkTimeout extends PageObservationContext {
  type: 'page.network.timeout'
  requestId: string
  method: string
  url: string
  timeoutMs: number
  timedOutAt: number
}

export interface PageObservationTimeout {
  type: 'page.observation.timeout'
  page?: string
  timeoutMs: number
  reason: string
  timedOutAt: number
}

/** 可选的页面可见内容快照；MVP 可以只实现网络观察。 */
export interface PageVisibleSnapshot {
  type: 'page.visible'
  page?: string
  text?: string
  tables?: Array<{
    columns: string[]
    rows: Array<Record<string, unknown>>
  }>
  capturedAt: number
}

/** 页面主动上报的数据快照（apiBus.report → agent 可见） */
export interface PageDataSnapshot {
  type: 'page.data'
  /** 当前页面 tag */
  page?: string
  /** 数据来源标识（通常与 dataSources.match 匹配） */
  source: string
  /** 摘要后的数据（只包含 dataSources 声明的字段） */
  data: unknown
  /** 是否被截断 */
  truncated: boolean
  /** 上报时间 */
  at: number
}

/**
 * 页面 `defineEmits` 事件入 session 历史。
 * 与 ws 协议 `page.emit` 对应；payload 与 network 观测一样需经 runtime 安全过滤。
 */
export interface PageEmit {
  type: 'page.emit'
  page?: string
  /** 事件名 */
  event: string
  /** 事件载荷（已过滤；JSON 可序列化优先） */
  payload?: unknown
  emittedAt: number
}

export type PageObservation =
  | PageNetworkRequest
  | PageNetworkResponse
  | PageNetworkError
  | PageNetworkTimeout
  | PageObservationTimeout
  | PageVisibleSnapshot
  | PageDataSnapshot
  | PageEmit

export interface ObservationMatch {
  page?: string
  requestId?: string
  method?: string
  /** URL 前缀或路径匹配 */
  url?: string
  /** 在安全响应数据或可见文本中查找的字符串 */
  contains?: string
}
