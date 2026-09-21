// 「回合边界」的客户端状态机（纯函数，零依赖，可单测）。
//
// 三张卡片 / 状态条都来自服务端的**结构化消息**（`chat.mode` / `chat.plan` / `chat.ask`），
// 而它们共同描述同一件事：这一轮是怎么结束的、现在等不等用户。
//   ① 计划卡：proposed（等确认）→ approved（执行中）
//   ② 问题卡：未回答（等回答）→ 已回答
//   ③ 模式条：每轮开头的判定结果（requested / effective / decidedBy / reason）
//
// 为什么不用 `ChatMessage` 承载卡片：`lib/chatTrace.ts` 把消息严格二分（气泡 / 过程区），
// 卡片是**交互控件**（有按钮、有状态迁移），塞进消息流会让"过程与结果分离"这条规矩破口。
import type { AgentMode } from '@webassistant/protocol'
import type { ChatAskMessage, ChatModeMessage, ChatPlanMessage } from '@webassistant/protocol/websocket'

/** 计划卡在客户端的两个阶段（服务端 `ChatPlanMessage.status` 的镜像，UI 只关心这两态） */
export type PlanCardStatus = 'proposed' | 'approved'

export interface PlanCard {
  message: ChatPlanMessage
  status: PlanCardStatus
  /**
   * 修改意见草稿（点「修改计划」展开输入框后写入；undefined = 没在改）。
   * UI 状态放这里（而不是组件内 ref）：两条渲染面共用同一批组件，放纯函数层才能一次改完、且可单测。
   */
  draft?: string
  /** 是否正在修订（已提交修改意见、等本轮结束）—— 用于禁用按钮与展示"修改中" */
  revising?: boolean
}

export interface AskCard {
  message: ChatAskMessage
  /** 已给出的回答（点选项或直接打字）；undefined = 还没回答 */
  answer?: string
}

export interface TurnState {
  /** 最近一次模式判定（状态行显示「当前模式」；null = 还没收到过） */
  mode: ChatModeMessage | null
  /** 当前计划卡（新计划覆盖旧计划；批准后仍保留以展示"已开始"） */
  plan: PlanCard | null
  /** 当前问题卡（新问题覆盖旧问题） */
  ask: AskCard | null
}

export function createTurnState(): TurnState {
  return { mode: null, plan: null, ask: null }
}

/** 模式条：每轮开头下发，直接覆盖 */
export function applyMode(state: TurnState, message: ChatModeMessage): TurnState {
  return { ...state, mode: message }
}

/**
 * 计划卡：**跟随服务端权威状态**（`ChatPlanMessage.status`）。
 *
 * 为什么不再无条件回到 `proposed`：修订（`revise_plan`）会让已批准的计划回落成 `proposed`
 * （计划变了就不是用户批准过的那一份，门禁要重新锁上），而**本地可能刚把它标成 approved** ——
 * 方向相反的迁移，客户端推不出来（修订不改 planId）。所以服务端给什么就用什么。
 *
 * 同 planId 的再次下发就是"这份计划被修订了"：`chat.plan` 里的 `revision` / `note` 随之更新，
 * 卡片在原地刷新（而不是像以前那样"旧卡作废 + 冒出一张新卡"）。
 *
 * `draft` / `revising` 都是**本地瞬时态，不进这里延续**：草稿只在"正在编辑"时存在
 * （提交即收起，见 `submitPlanRevision`），服务端推来新卡片一律清掉 ——
 * 否则修订结果回来后卡片会**卡在输入态**（`editing` 为真），用户看不到「开始执行」按钮。
 * （面板的折叠态不在这里：它是纯视图状态，与过程区共用 `usePanelOpen`，见 components/PanelSection.vue。）
 */
export function applyPlan(state: TurnState, message: ChatPlanMessage): TurnState {
  return {
    ...state,
    plan: {
      message,
      status: message.status ?? 'proposed',
      // 修订结果已经回来了（或换了一份计划）→ 退出"修改中"，并收起输入框
      revising: false,
    },
  }
}

/** 「修改计划」：展开输入框（草稿初始为空串；`planId` 不匹配则不动 —— 那是过期卡片） */
export function beginPlanRevision(state: TurnState, planId: string): TurnState {
  if (!state.plan || state.plan.message.planId !== planId) return state
  return { ...state, plan: { ...state.plan, draft: state.plan.draft ?? '' } }
}

/** 输入框内容变化 */
export function updatePlanDraft(state: TurnState, draft: string): TurnState {
  if (!state.plan || state.plan.draft === undefined) return state
  return { ...state, plan: { ...state.plan, draft } }
}

/** 取消修改（收起输入框，丢弃草稿） */
export function cancelPlanRevision(state: TurnState): TurnState {
  if (!state.plan) return state
  const { draft: _draft, ...rest } = state.plan
  return { ...state, plan: { ...rest, revising: false } }
}

/**
 * 提交修改：**收起输入框** + 标"修改中"，等服务端 `chat.plan` 回来刷新。
 *
 * 为什么提交即收起（而不是等结果回来才收）：修订是一个有始有终的动作，提交后卡片应立刻回到
 * 可操作态并显示「正在按你的意见更新计划…」；文字本身已经作为用户气泡进了对话，失败也能看到原文，
 * 不必再用草稿"占着"输入框（那会让卡片一直停在输入视图里）。
 */
export function submitPlanRevision(state: TurnState, planId: string): TurnState {
  if (!state.plan || state.plan.message.planId !== planId) return state
  const { draft: _draft, ...rest } = state.plan
  return { ...state, plan: { ...rest, revising: true } }
}

/**
 * 本轮结束（`chat.done` / `chat.error`）时收尾修订中的标记。
 *
 * 正常路径下 `chat.plan` 已经把 `revising` 清掉了；这里兜的是"本轮失败了"——
 * 不清的话卡片会一直显示「修改中…」，而那条修改意见其实已经失败、草稿还留着可重试。
 */
export function settlePlanRevision(state: TurnState): TurnState {
  if (!state.plan?.revising) return state
  return { ...state, plan: { ...state.plan, revising: false } }
}

/**
 * 本地立即把计划标为已批准（`planId` 不匹配则不动 —— 那是过期卡片，服务端会回提示）。
 * 先本地迁移再等服务端，是为了让「开始执行」的点击有即时反馈。
 */
export function approvePlanCard(state: TurnState, planId: string): TurnState {
  if (!state.plan || state.plan.message.planId !== planId) return state
  return { ...state, plan: { ...state.plan, status: 'approved' } }
}

/** 问题卡：新问题覆盖旧问题（一次只问一个） */
export function applyAsk(state: TurnState, message: ChatAskMessage): TurnState {
  return { ...state, ask: { message, answer: undefined } }
}

/**
 * 本地记录回答。
 * `questionId` 缺省（用户直接打字）也算回答当前问题 —— 与服务端的判定保持一致，
 * 否则卡片会一直停在"等待回答"，而服务端那边其实已经收下了答案。
 */
export function answerAskCard(state: TurnState, answer: string, questionId?: string): TurnState {
  const card = state.ask
  if (!card || card.answer !== undefined) return state
  if (questionId && card.message.questionId !== questionId) return state
  return { ...state, ask: { ...card, answer } }
}

/** 当前是否在等用户回答（决定 `send()` 要不要带上 questionId） */
export function pendingQuestionId(state: TurnState): string | undefined {
  const card = state.ask
  if (!card || card.answer !== undefined) return undefined
  return card.message.questionId
}

/** 计划卡是否该渲染（批准后仍渲染，但折叠为"执行中"） */
export function visiblePlanCard(state: TurnState): PlanCard | null {
  return state.plan
}

/** 问题卡是否该渲染 */
export function visibleAskCard(state: TurnState): AskCard | null {
  return state.ask
}

/** 状态行的模式文案 */
export function describeMode(mode: ChatModeMessage | null): string {
  if (!mode) return ''
  const label = mode.effective === 'plan' ? '计划模式' : '直接执行'
  const source =
    mode.decidedBy === 'user' ? '手动' : mode.decidedBy === 'heuristic' ? '自动判定' : '模型自选'
  return `${label} · ${source}`
}

/** 用户在 ModeSwitch 上的可选项（`auto` 是"交给服务端 / 模型判"） */
export const MODE_OPTIONS: ReadonlyArray<{ value: AgentMode; label: string; hint: string }> = [
  { value: 'auto', label: '自动', hint: '简单任务直接做，复杂任务先出计划' },
  { value: 'act', label: '直接执行', hint: '不拆计划，直接操作页面' },
  { value: 'plan', label: '先出计划', hint: '先给计划，确认后再执行' },
]
