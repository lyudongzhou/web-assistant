import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type {
  AgentMode,
  AgentPlan,
  AgentSession,
  CurrentPage,
  ModeDecision,
  PageObservation,
  ObservationMatch,
  PendingQuestion,
  PlanTurn,
  StepTurn,
} from '@webassistant/protocol'
import { MemorySessionStore, type SessionStore } from './session.store.js'
// 纯函数复用：`turnEnd.ts` 零依赖（只 import protocol 类型），不会与 agent.service 形成环，
// 而"用户推进等待中的步骤"这条规则必须与 `handoff_step` 的写入规则放在同一处（一写一读，口径不能漂）。
import { applyUserStepDone } from '../agent/turnEnd.js'

/**
 * 僵尸会话兜底回收窗口（仅异常路径）。
 * 正常路径下会话在连接断开时由 `destroy()` **立即**回收；这个 TTL 只兜底
 * 「连接未触发 disconnect」（进程异常、半开连接）的残留，语义是回收而非保活。
 */
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000)
const MAX_OBSERVATIONS = 100

export type ObservationWaitResult =
  | { status: 'completed'; observations: PageObservation[] }
  | { status: 'failed'; error: string }
  | { status: 'timed_out'; timeoutMs: number }

interface ObservationWaiter {
  sessionId: string
  match: ObservationMatch
  timer: NodeJS.Timeout
  resolve: (result: ObservationWaitResult) => void
}

@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly store: SessionStore = new MemorySessionStore()
  private readonly waiters = new Map<string, ObservationWaiter>()
  private readonly cleanupTimer: NodeJS.Timeout

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000)
    this.cleanupTimer.unref()
  }

  /**
   * 创建一个新会话（**会话 = 连接**：每次握手都新建，不复用客户端传来的 id）。
   * 会话上下文随连接销毁，见 `destroy()`。
   */
  create(): AgentSession {
    const session: AgentSession = {
      id: randomUUID(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      recentObservations: [],
    }
    this.store.set(session)
    return session
  }

  /**
   * 销毁会话（连接断开时调用）：删除会话本体，并**立即结束**挂在该会话上的观察等待。
   * 不这样清理的话，`waitForObservation` 只能等自己的 timeout 结束 —— 白占计时器、白等一段时间。
   */
  destroy(sessionId: string): void {
    this.store.delete(sessionId)
    for (const [id, waiter] of this.waiters) {
      if (waiter.sessionId !== sessionId) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(id)
      waiter.resolve({ status: 'failed', error: 'session destroyed' })
    }
  }

  touch(session: AgentSession): void {
    session.lastSeenAt = Date.now()
  }

  recordNavigation(session: AgentSession, page: CurrentPage): void {
    session.currentPage = page
    this.touch(session)
  }

  /**
   * 记录当前页 expose 能力清单（最近一次覆盖）。
   * Agent prompt 通过 session.pageExposedKeys + session.currentPage 拼出「当前页可用方法」。
   * 不进 recentObservations（这是元数据，不是事件流）。
   */
  recordPageExposed(
    session: AgentSession,
    payload: { tag: string; keys: string[] },
  ): void {
    if (!session.pageExposedKeys) session.pageExposedKeys = {}
    session.pageExposedKeys[payload.tag] = payload.keys
    this.touch(session)
  }

  recordObservation(session: AgentSession, observation: PageObservation): void {
    this.touch(session)
    session.recentObservations.push(observation)
    if (session.recentObservations.length > MAX_OBSERVATIONS) {
      session.recentObservations.splice(0, session.recentObservations.length - MAX_OBSERVATIONS)
    }
    this.resolveMatchingWaiters(session.id, observation)
  }

  waitForObservation(sessionId: string, match: ObservationMatch, timeoutMs: number): Promise<ObservationWaitResult> {
    const session = this.store.get(sessionId)
    if (!session) return Promise.resolve({ status: 'failed', error: 'session not found' })
    const existing = session.recentObservations.filter((observation) => this.matches(observation, match))
    if (existing.length) return Promise.resolve({ status: 'completed', observations: existing })

    return new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        resolve({ status: 'timed_out', timeoutMs })
      }, timeoutMs)
      this.waiters.set(id, { sessionId, match, timer, resolve })
    })
  }

  find(sessionId: string): AgentSession | undefined {
    return this.store.get(sessionId)
  }

  // ---- 模式（add-agent-modes-and-plan-turns）----
  // 三者都是**连接作用域**的：随会话销毁而消失，不落盘、不进 rpc（与 session-per-connection 一致）。

  /** 记录本连接的模式请求值（客户端显式给了就更新；缺省沿用） */
  setMode(session: AgentSession, mode: AgentMode): void {
    session.mode = mode
    this.touch(session)
  }

  /** 记录本轮模式判定结果（`chat.mode` 的来源） */
  setModeDecision(session: AgentSession, decision: ModeDecision): void {
    session.modeDecision = decision
    this.touch(session)
  }

  /**
   * 落一个新计划。
   * 旧计划被标为 `superseded`（而不是直接删）—— 客户端可能还拿着旧 planId 点「开始执行」，
   * 那时 `approvePlan()` 能明确回「计划已更新」，而不是静默批准一个新计划。
   */
  recordPlan(session: AgentSession, plan: AgentPlan): void {
    if (session.plan && session.plan.id !== plan.id) session.plan.status = 'superseded'
    session.plan = plan
    this.touch(session)
  }

  /** 覆盖计划（进度更新用；不标记 superseded） */
  updatePlan(session: AgentSession, plan: AgentPlan | undefined): void {
    if (!plan) return
    session.plan = plan
    this.touch(session)
  }

  /**
   * 用**修订后**的计划原地替换当前计划（`revise_plan`）。
   *
   * 与 `recordPlan()` 的关键区别：**不标 `superseded`、不改 `id`** —— 修订的语义是"改这一份计划"，
   * 所以卡片延续、旧 `planId` 依然有效（用户改完能直接用同一张卡点「开始执行」）。
   *
   * 批准状态必须重新对齐：修订前已批准的计划，内容已不再是用户批准过的那一份，
   * 于是回到 `proposed` 并**清空 `approvedAt`** —— plan 门禁（`hooks.beforeTool`）判的就是
   * `approvedAt`，不清会出现"计划改了、门禁还开着"的安全漏洞。
   *
   * 返回 `'stale'` 表示客户端拿的 planId 与会话当前计划不一致（过期卡片）：
   * 调用方据此提示用户重新提交，而不是把修订合并进一份陌生的计划。
   */
  revisePlan(session: AgentSession, planId: string, revised: AgentPlan): 'revised' | 'stale' | 'none' {
    const current = session.plan
    if (!current) return 'none'
    if (current.id !== planId) return 'stale'
    const wasApproved = current.approvedAt != null
    session.plan = {
      ...revised,
      id: current.id,
      // 前面已批准的步骤状态由 revised.steps 带走（mergePlanRevision 保证），这里只对齐批准状态
      ...(wasApproved ? { status: 'proposed' as const } : {}),
    }
    if (wasApproved) delete session.plan.approvedAt
    this.touch(session)
    return 'revised'
  }

  // ---- 计划修改意图（本轮，`chat.send.revisePlanId`）----

  /**
   * 记录本轮的修改计划意图。
   * prompt 构建与 `hooks.beforeTool` 都要在**模型调用工具之前**读到它，所以不能只存在工具入参里。
   */
  setPlanTurn(session: AgentSession, turn: PlanTurn | undefined): void {
    if (turn) session.planTurn = turn
    else delete session.planTurn
    this.touch(session)
  }

  // ---- 人工步骤（本轮，`chat.send.stepDoneId`）----

  /**
   * 用户点「我已完成，下一步」：把**等待中的那一步**标 `done` 并清 `issue`。
   *
   * 为什么是服务端权威：`waiting-user` 的步骤不接受模型自报进度（`applyPlanProgress` 会跳过它），
   * 用户这个动作是它唯一的推进口 —— 判据与方法都放在这里，调用方（gateway）只负责把结果变成给用户看的话。
   *
   * 四种结果（都不阻断本轮照常起跑，否则客户端会卡在 loading）：
   * - `done`：推进成功；
   * - `stale`：客户端拿的 planId 与会话当前计划不一致（过期卡片）；
   * - `mismatch`：stepId 指向的步骤当前不在等用户（已推进过 / 已被交接成了另一步）；
   * - `none`：当前没有计划。
   */
  completeUserStep(
    session: AgentSession,
    planId: string | undefined,
    stepId: string,
  ): 'done' | 'stale' | 'mismatch' | 'none' {
    const plan = session.plan
    if (!plan) return 'none'
    if (planId && plan.id !== planId) return 'stale'
    const result = applyUserStepDone(plan, stepId)
    if (!result) return 'mismatch'
    session.plan = result.plan
    this.touch(session)
    return 'done'
  }

  /**
   * 记录本轮的人工步骤回执（与 `setPlanTurn` 对称）。
   * prompt 构建要在**模型调用工具之前**知道"用户刚把第 N 步做完了"，模型据此先校验再继续。
   */
  setStepTurn(session: AgentSession, turn: StepTurn | undefined): void {
    if (turn) session.stepTurn = turn
    else delete session.stepTurn
    this.touch(session)
  }

  /**
   * 用户确认计划。返回 `'stale'` 表示客户端拿的 planId 与会话当前计划不一致
   * （期间重新规划过：`recordPlan()` 会把旧计划标成 `superseded`）——
   * 调用方据此提示用户重新确认，而不是错误地批准一个新计划。
   */
  approvePlan(session: AgentSession, planId: string): 'approved' | 'stale' | 'none' {
    const plan = session.plan
    if (!plan) return 'none'
    if (plan.id !== planId) return 'stale'
    plan.status = 'approved'
    plan.approvedAt = Date.now()
    this.touch(session)
    return 'approved'
  }

  // ---- 提问（clarifying questions）----

  /** 落一个待回答问题（覆盖上一次未回答的：一次只问一个问题） */
  recordQuestion(session: AgentSession, question: PendingQuestion): void {
    session.pendingQuestion = question
    this.touch(session)
  }

  /**
   * 标记问题已回答。
   * - 带 `questionId` 时要求匹配当前问题，不匹配则返回 `false`（客户端拿的是旧问题）；
   * - 不带 `questionId` 时（用户直接打字）视为回答当前未回答的问题。
   */
  answerQuestion(session: AgentSession, answer: string, questionId?: string): boolean {
    const question = session.pendingQuestion
    if (!question || question.answeredAt) return false
    if (questionId && question.id !== questionId) return false
    question.answer = answer
    question.answeredAt = Date.now()
    this.touch(session)
    return true
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer)
    for (const waiter of this.waiters.values()) clearTimeout(waiter.timer)
    this.waiters.clear()
  }

  private resolveMatchingWaiters(sessionId: string, observation: PageObservation): void {
    for (const [id, waiter] of this.waiters) {
      if (waiter.sessionId !== sessionId || !this.matches(observation, waiter.match)) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(id)
      waiter.resolve({ status: 'completed', observations: [observation] })
    }
  }

  private matches(observation: PageObservation, match: ObservationMatch): boolean {
    if (match.page && observation.page !== match.page) return false
    if (match.source) {
      if (observation.type !== 'page.data' || observation.source !== match.source) return false
    }
    if (match.event) {
      if (observation.type !== 'page.emit' || observation.event !== match.event) return false
    }
    if (match.contains) {
      const text = observation.type === 'page.emit'
        ? `${observation.event}\n${JSON.stringify(observation.payload ?? null)}`
        : JSON.stringify(observation)
      if (!text.includes(match.contains)) return false
    }
    return true
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const session of this.store.values()) {
      if (now - session.lastSeenAt > SESSION_TTL_MS) this.store.delete(session.id)
    }
  }
}

