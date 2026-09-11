// Agent session 的共享数据模型。
// 连接可以断开，但 session 上下文独立存活；连接级 pending call 不持久化。

import type { PageNetworkRequest, PageObservation } from './observation.js'

export type AgentRunStatus =
  | 'running'
  | 'waiting-observation'
  | 'waiting-user'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ChatTurnRole = 'user' | 'assistant' | 'system'

export interface ChatTurn {
  role: ChatTurnRole
  content: string
  createdAt: number
}

export type NavigationSource = 'page' | 'host' | 'agent'

export interface CurrentPage {
  tag: string
  params: Record<string, unknown>
  title?: string
  source: NavigationSource
  at: number
}

export interface AgentRun {
  id: string
  status: AgentRunStatus
  goal: string
  startedAt: number
  updatedAt: number
  stepCount: number
  deadline: number
}

export interface ObservationWait {
  id: string
  runId: string
  page?: string
  timeoutMs: number
  startedAt: number
  deadline: number
  status: 'waiting' | 'completed' | 'failed' | 'timed_out' | 'cancelled'
}

export interface AgentSession {
  id: string
  createdAt: number
  lastSeenAt: number
  history: ChatTurn[]
  currentPage?: CurrentPage
  /** request start 之后尚未收到终态的请求 */
  pendingRequests: Map<string, PageNetworkRequest>
  recentObservations: PageObservation[]
  /**
   * 页面 `defineExpose` 能力清单缓存（tag → key 列表，最近一次覆盖）。
   * chat-client 接到 runtime 的 'page-exposed-changed' 后通过 ws `page.exposed` 写入。
   * prompt 构建时取 `pageExposedKeys[currentPage.tag]` 拼「当前页可用方法」。
   */
  pageExposedKeys?: Record<string, string[]>
  activeRun?: AgentRun
  /** 当前连接 ID；断线时清空，session 本身保留 */
  socketId?: string
}
