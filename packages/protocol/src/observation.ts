// Runtime → agent 的页面观察契约。
//
// ⚠️ 数据出网原则：runtime **不自动采集**任何东西（不拦 fetch / XHR、不监听请求）。
// 只有调用方（宿主 / 页面）显式调 `apiBus.report()`，数据才会以 `page.data` 的形式进来。
//
// 业务页面不需要调用这些 API；它们只是「宿主 / 页面主动上报」与「agent 等待」之间的形状约定。

/** 页面主动上报的数据快照（apiBus.report → agent 可见） */
export interface PageDataSnapshot {
  type: 'page.data'
  /** 当前页面 tag */
  page?: string
  /** 数据来源标识（调用方给的 `source`，或命中 manifest dataSources 的 `match`） */
  source: string
  /** 上报的数据（调用方显式给出；runtime 只施加体积上限） */
  data: unknown
  /** 是否被截断 */
  truncated: boolean
  /** 上报时间 */
  at: number
}

/**
 * 页面 `defineEmits` 事件入 session 历史。
 * 与 ws 协议 `page.emit` 对应。
 */
export interface PageEmit {
  type: 'page.emit'
  page?: string
  /** 事件名 */
  event: string
  /** 事件载荷（JSON 可序列化优先） */
  payload?: unknown
  emittedAt: number
}

/** 可选的页面可见内容快照；MVP 可以只实现数据上报。 */
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

export interface PageObservationTimeout {
  type: 'page.observation.timeout'
  page?: string
  timeoutMs: number
  reason: string
  timedOutAt: number
}

export type PageObservation =
  | PageDataSnapshot
  | PageEmit
  | PageVisibleSnapshot
  | PageObservationTimeout

/**
 * 等待观察的匹配条件。
 * 数据面只有「显式上报的 page.data」与「页面派发的 page.emit」两种，所以匹配维度是
 * 来源名 / 事件名 / 页面，以及 `contains`（在序列化数据里做子串匹配）。
 */
export interface ObservationMatch {
  page?: string
  /** `page.data` 的来源标识（apiBus.report 的 `source`，或命中 dataSources 的 `match`） */
  source?: string
  /** `page.emit` 的事件名 */
  event?: string
  /** 在数据 / 载荷里查找的字符串 */
  contains?: string
}
