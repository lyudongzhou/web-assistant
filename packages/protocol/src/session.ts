// Agent session 的共享数据模型。
//
// 生命周期语义：**一个会话 = 一条 WebSocket 连接**（connection-scoped）。
// 握手（session.hello）时创建，连接断开时销毁；会话标识与内容都不落任何持久化介质，
// 连接级 pending call 同样不持久化。多轮对话由连接内的长驻 agent runtime 承载。

import type { PageObservation } from './observation.js'

export type AgentRunStatus =
  | 'running'
  | 'waiting-observation'
  | 'waiting-user'
  | 'completed'
  | 'failed'
  | 'cancelled'

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
  currentPage?: CurrentPage
  recentObservations: PageObservation[]
  /**
   * 页面 `defineExpose` 能力清单缓存（tag → key 列表，最近一次覆盖）。
   * chat-client 接到 runtime 的 'page-exposed-changed' 后通过 ws `page.exposed` 写入。
   * prompt 构建时取 `pageExposedKeys[currentPage.tag]` 拼「当前页可用方法」。
   */
  pageExposedKeys?: Record<string, string[]>
  activeRun?: AgentRun
}
