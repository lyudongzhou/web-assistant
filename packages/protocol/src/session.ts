// Agent session 的共享数据模型。
//
// 生命周期语义：**一个会话 = 一条 WebSocket 连接**（connection-scoped）。
// 握手（session.hello）时创建，连接断开时销毁；会话标识与内容都不落任何持久化介质，
// 连接级 pending call 同样不持久化。多轮对话由连接内的长驻 agent runtime 承载。
//
// 回合边界（`add-agent-modes-and-plan-turns`）：
// 计划确认 / 澄清提问 / 进度交接三件事共用同一套状态机 —— 本轮 run 由**收尾工具**
// （`propose_plan` / `ask_user` / `finish_turn`，`lifecycle.completesRun`）正常 `completed`，
// 会话随之记录 `plan` / `pendingQuestion` 并把本轮标记为 `waiting-plan` / `waiting-user`；
// 用户操作经下一次 `chat.send`（带 `planId` / `questionId`）起下一轮。
//
// 计划的"改"（`add-interactive-plan-revision`）：用户带修改意见的 `chat.send`（`revisePlanId`）
// → 本轮记 `planTurn`（意图）→ 模型必须调 `revise_plan`（修订轮内 `propose_plan` 被硬拦）
// → 服务端按 `PlanStep.id` **增量合并**（保状态、保进度、`planId` 不变、`revision+1`）
// → 计划卡原地更新，并回到 `proposed` 重新确认。

import type { PageObservation } from './observation.js'

export type AgentRunStatus =
  | 'running'
  | 'waiting-observation'
  | 'waiting-user'
  /** 已给出计划、正在等用户确认（`chat.plan` 的卡片状态） */
  | 'waiting-plan'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type NavigationSource = 'page' | 'host' | 'agent'

/**
 * 模式请求值（客户端可指定，属于会话）。
 * - `auto`：由服务端判定（显式 > 启发式 > 模型自判），默认
 * - `act`：直接执行（不做计划门禁）
 * - `plan`：先出计划再执行（未确认计划时操作页面被硬拦）
 */
export type AgentMode = 'auto' | 'act' | 'plan'

/** 实际生效的模式（`auto` 判定后的落点，只有两种） */
export type EffectiveMode = 'act' | 'plan'

/** 模式判定来源：用户显式 / 启发式规则 / 交给模型自判 */
export type ModeDecidedBy = 'user' | 'heuristic' | 'model'

/** 一轮的模式判定结果（每轮通过 `chat.mode` 下发，UI 据此显示「当前模式」） */
export interface ModeDecision {
  requested: AgentMode
  effective: EffectiveMode
  decidedBy: ModeDecidedBy
  /** 面向用户的判定理由（如「检测到多步任务」），可缺省 */
  reason?: string
}

/** 计划步骤状态 */
export type PlanStepStatus = 'pending' | 'done'

export interface PlanStep {
  /** 会话内稳定标识（进度交接按它对应） */
  id: string
  title: string
  detail?: string
  status: PlanStepStatus
}

export type AgentPlanStatus = 'proposed' | 'approved' | 'completed' | 'superseded'

/** 当前计划（连接作用域：断开即销毁） */
export interface AgentPlan {
  id: string
  summary: string
  steps: PlanStep[]
  status: AgentPlanStatus
  createdAt: number
  /** 第几版（首版 1；每次 `revise_plan` 修订 +1） */
  revision?: number
  /** 最近一次修订时间 */
  revisedAt?: number
  /** 用户确认（`chat.send` 带 `planId`）的时间 */
  approvedAt?: number
  completedAt?: number
}

/**
 * 本轮的"计划修改意图"（`chat.send` 带 `revisePlanId` 时写入，仅本轮有效）。
 *
 * 为什么把它落成会话状态而不是只用工具入参：prompt 构建（`buildAgentContext`）与
 * `hooks.beforeTool` 都需要在**模型调用工具之前**知道"本轮是修订轮"——
 * 前者要注入"用户想改哪里"，后者要拦下 `propose_plan`（防止"改计划"退化成"换计划"）。
 */
export interface PlanTurn {
  kind: 'revise'
  /** 被修订的计划 id（客户端带上来的 `revisePlanId`） */
  planId: string
  /** 用户的修改意见（即本轮 `chat.send.text`） */
  text: string
  at: number
}

/** 待用户回答的问题（`ask_user` 产出；回答后保留回答内容供后续轮次引用） */
export interface PendingQuestion {
  id: string
  question: string
  options: string[]
  askedAt: number
  answeredAt?: number
  answer?: string
}

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
  /** 本连接的当前模式请求值（`auto` / `act` / `plan`；缺省按 MODE_DEFAULT） */
  mode?: AgentMode
  /** 最近一次模式判定结果（`chat.mode` 的来源） */
  modeDecision?: ModeDecision
  /** 当前计划（待确认 / 执行中 / 已完成；连接作用域） */
  plan?: AgentPlan
  /** 本轮的修改计划意图（`chat.send` 带 `revisePlanId` 时写入；每轮重置） */
  planTurn?: PlanTurn
  /** 最近一次提问（含已回答的历史：`answeredAt` 非空表示已有答复） */
  pendingQuestion?: PendingQuestion
}
