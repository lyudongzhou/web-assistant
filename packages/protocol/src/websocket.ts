// Agent ↔ chat-client 的 WebSocket 协议。
// 所有消息带 t，双方对未知 t 应忽略并记录日志，以便协议向前演进。

import type {
  ObservationMatch,
  PageDataSnapshot,
} from './observation.js'
import type {
  AgentMode,
  ModeDecision,
  NavigationSource,
  PlanStep,
} from './session.js'

export const CLIENT_MESSAGE = {
  SessionHello: 'session.hello',
  ChatSend: 'chat.send',
  ChatCancel: 'chat.cancel',
  ToolResult: 'tool.result',
  PageNavigated: 'page.navigated',
  PageData: 'page.data',
  PageEmit: 'page.emit',
  PageExposed: 'page.exposed',
  Ping: 'ping',
} as const

export const SERVER_MESSAGE = {
  SessionReady: 'session.ready',
  ChatMode: 'chat.mode',
  ChatText: 'chat.text',
  AgentStep: 'agent.step',
  ToolCall: 'tool.call',
  ChatPlan: 'chat.plan',
  ChatAsk: 'chat.ask',
  ChatDone: 'chat.done',
  ChatError: 'chat.error',
  Pong: 'pong',
} as const

/**
 * 工具名。
 *
 * 前三个走 `tool.call` RPC（浏览器执行）；后五个是**服务端收尾工具**
 * （`lifecycle.completesRun`，只更新 session 并产出 `chat.plan` / `chat.ask` / 进度文本，
 * **不会**出现在 `tool.call` 里）—— 它们出现在 `ToolName` 里是为了让过程区
 * （`agent.step.tool`）能给出准确文案。
 */
export type ToolName =
  | 'render'
  | 'wait_for_observation'
  | 'call_page_method'
  | 'propose_plan'
  | 'revise_plan'
  | 'handoff_step'
  | 'ask_user'
  | 'finish_turn'

/** 服务端收尾工具（completesRun）的子集 —— 判断"本轮是怎么结束的"时用它 */
export type TurnEndToolName =
  | 'propose_plan'
  | 'revise_plan'
  | 'handoff_step'
  | 'ask_user'
  | 'finish_turn'

/**
 * 握手消息。**不带会话标识**：会话是连接作用域的（一个会话 = 一条连接），
 * 服务端在收到本消息时创建新会话并在 `session.ready` 中回传 id。
 * 客户端不持久化、也不复用任何会话 id（刷新/重连即新会话）。
 */
export interface SessionHelloMessage {
  t: 'session.hello'
  wcBase: string
  manifestVersion: number
}

export interface ChatSendMessage {
  t: 'chat.send'
  text: string
  /**
   * 本轮的模式请求值（`auto` / `act` / `plan`）。
   * 缺省 = 沿用会话当前模式（初始为服务端 `MODE_DEFAULT`）。给了就更新会话模式。
   */
  mode?: AgentMode
  /** 确认某个计划（计划卡上的「开始执行」）：值为 `chat.plan` 下发的 planId */
  planId?: string
  /**
   * 本轮是"对某个计划的修改意见"（计划卡上的「修改计划」）：值为当前 `chat.plan` 的 planId，
   * `text` 即用户的修改意见。
   *
   * 与 `planId`（确认）/ `questionId`（回答）同属"回合边界的用户回应"，但语义不同：
   * 确认 = 照这份计划执行；修改 = **在这份计划上改**（服务端据此标记本轮为修订轮，
   * 模型必须调用 `revise_plan` 并回填完整步骤，未改动的步骤保留原 step id，进度因此不丢）。
   */
  revisePlanId?: string
  /**
   * 用户点计划卡上的「我已完成，下一步」：值为**被推进的步骤 id**（如 `step-3`），
   * 与 `planId` 一起下发（`planId` 仍是当前计划，用于过期判断）。
   *
   * 语义 = "这一步我在页面上手做完了，你校验并继续" —— 它是**人工步骤唯一的推进口**：
   * `waiting-user` 的步骤只认它，`finish_turn` 的 `done` 填了也不生效（见 `add-plan-manual-steps`）。
   */
  stepDoneId?: string
  /** 回答某个提问（问题卡上的选项 / 直接打字）：值为 `chat.ask` 下发的 questionId */
  questionId?: string
}

export interface ChatCancelMessage {
  t: 'chat.cancel'
}

export interface ToolResultSuccess {
  t: 'tool.result'
  id: string
  ok: true
  data: unknown
}

export interface ToolResultFailure {
  t: 'tool.result'
  id: string
  ok: false
  error: string
  timedOut?: boolean
}

export type ToolResultMessage = ToolResultSuccess | ToolResultFailure

/**
 * agent 动作（activity）的 ack 状态。ack 以 **in-band** 方式走 `tool.result`，
 * 与那次 tool 调用靠 function-calling 的 tool-result 通道一一对应，模型无需识别 id。
 * - `done`：动作已被框架受理并完成（如 render —— 收到即已完成，不代表页面/数据就绪）
 * - `success`：页面方法执行成功（Promise resolve，或非 Promise 同步返回）
 * - `failure`：页面方法执行失败（对应 tool.result.ok = false）
 */
export type ActivityStatus = 'done' | 'success' | 'failure'

/** `tool.result.data` 的规范化形状（成功分支，ok = true）。 */
export interface ActivityAckData {
  status: ActivityStatus
  /** 动作目标：render 的 tag / call_page_method 的方法名 */
  target?: string
  /** 页面方法返回值（Promise resolve 值或非 Promise 同步返回值）；无返回值时省略 */
  value?: unknown
  /** call_page_method 专用：方法是否以 Promise 结算（显式判定返回类型） */
  async?: boolean
}

export interface PageNavigatedMessage {
  t: 'page.navigated'
  tag: string
  params: Record<string, unknown>
  source: NavigationSource
  navigationId?: string
  title?: string
}

export type PageDataMessage = Omit<PageDataSnapshot, 'type'> & { t: 'page.data' }

/**
 * 页面 Vue `defineEmits` 事件回传（通知面第二条腿）。
 * runtime 在容器 shadow root 内捕获原生 CustomEvent → ws 转发 → session 入历史。
 */
export interface PageEmitMessage {
  t: 'page.emit'
  tag: string
  /** 事件名（manifest.pages[].emits 里声明的；未声明但启用了全量监听也会转发） */
  event: string
  /** 事件载荷（CustomEvent.detail，需 JSON 可序列化） */
  payload?: unknown
  /** 事件产生时间 */
  at?: number
}

/**
 * 页面 `defineExpose` 能力清单上报。
 * runtime 透出 element.exposed 的键列表（仅 key，不含函数体），agent 据此知道可调用什么。
 */
export interface PageExposedMessage {
  t: 'page.exposed'
  tag: string
  keys: string[]
}

export interface PingMessage {
  t: 'ping'
}

export type ClientMessage =
  | SessionHelloMessage
  | ChatSendMessage
  | ChatCancelMessage
  | ToolResultMessage
  | PageNavigatedMessage
  | PageDataMessage
  | PageEmitMessage
  | PageExposedMessage
  | PingMessage

export interface SessionReadyMessage {
  t: 'session.ready'
  /** 本次连接新建会话的 id（连接作用域：断开即失效，客户端不持久化） */
  sessionId: string
  manifestVersion: number
  /**
   * 连接建立时 agent 下发的欢迎载荷（可选）：
   * 客户端渲染区「欢迎页」据此展示欢迎语 + 能力卡片。随握手一并下发，顺序天然正确。
   */
  welcome?: WelcomePayload
}

/**
 * 本轮的**模式判定结果**（每轮开始时先于任何 `chat.text` / `agent.step` 下发）。
 *
 * 客户端据此显示「当前模式」与它是怎么被决定的；`effective === 'plan'` 且计划未确认时，
 * 服务端会硬拦 `render` / `call_page_method`（见 `PLAN_GATE`）。
 */
export interface ChatModeMessage {
  t: 'chat.mode'
  /** 本轮请求的模式（客户端给的，或会话当前的） */
  requested: AgentMode
  /** 实际生效的模式（`auto` 判定后的落点） */
  effective: ModeDecision['effective']
  /** 判定来源：用户显式 / 启发式 / 交给模型自判 */
  decidedBy: ModeDecision['decidedBy']
  /** 面向用户的判定理由（可缺省） */
  reason?: string
}

/**
 * 能力项：agent 能打开的页面（由 agent-server 从 manifest 派生，零 LLM 成本）。
 * 客户端「欢迎页」渲染成卡片；`tag` 为将来「点击直达」预留。
 */
export interface WelcomeCapability {
  /** 页面自定义元素标签（render 的目标） */
  tag: string
  /** 路由名（PascalCase） */
  name?: string
  title?: string
  description?: string
  /** 示例说法（取自 manifest 的 exampleQueries / keywords） */
  examples?: string[]
}

/** 连接建立时 agent 下发的欢迎载荷。 */
export interface WelcomePayload {
  /** 欢迎语正文（可含换行） */
  text: string
  /** 能力清单（agent 可操作的页面） */
  capabilities: WelcomeCapability[]
}

/**
 * 助手流式文本增量。
 *
 * `channel` 区分**结果**与**思考**（缺省 `'text'`）：
 * - `'text'`：给用户的答复正文 —— 客户端渲染成结果气泡
 * - `'reasoning'`：模型的思考/推理增量（provider 的 reasoning_content）—— 客户端渲染进「过程区」，
 *   与结果气泡**分离**，用户能看清「想的」与「答的」
 *
 * 为什么用**可选字段**而不是新增一个 `chat.reasoning` 消息类型：本文件顶部约定「未知 t 应忽略并记录日志」，
 * 新增顶层 t 会让旧客户端**静默丢掉**思考内容；而一个不认识的字段不会 —— 旧端把 reasoning 增量
 * 当普通文本渲染（内容不丢、不崩），只是不分栏。新老两端因此可以各自升级。
 */
export interface ChatTextMessage {
  t: 'chat.text'
  delta: string
  channel?: 'text' | 'reasoning'
}

/**
 * 过程步骤的阶段：
 * - `'start'`：开始执行（`wait_for_observation` 这类可能持续数秒，UI 需要一个"进行中"状态）
 * - `'end'`：已结算 —— 带 `ok` / `error` / `durationMs`，UI 据此把那一行"闭合"（✓ / ✗ + 耗时）
 */
export type AgentStepPhase = 'start' | 'end'

/**
 * agent 执行轨迹的一步（过程，不是结果）。
 *
 * 客户端**不应**把它追加进结果气泡：`docs/agent-session.md` §10 的既定 UX 是
 * 「每个 agent.step 一条浅色系统气泡（过程区）」，与结果气泡分开。
 */
export interface AgentStepMessage {
  t: 'agent.step'
  index: number
  /** 面向用户的一句话（server 侧已含动作目标，如「正在打开页面 user-list」） */
  text: string
  /** 缺省 `'start'`（兼容只推 start 的旧 server） */
  phase?: AgentStepPhase
  /** 结构化工具名 —— UI 可据此分组/配色，不必解析 text */
  tool?: ToolName
  /** 动作目标：render 的 tag / call_page_method 的方法名 */
  target?: string
  /** 工具实参（render 的 params/props 等）—— 过程区点开可看细节 */
  args?: unknown
  /** 仅 `phase: 'end'`：是否成功（缺省视为成功） */
  ok?: boolean
  /** 仅 `phase: 'end'`：失败原因 */
  error?: string
  /** 仅 `phase: 'end'`：从 start 到结算的耗时 */
  durationMs?: number
}

export interface RenderToolArgs {
  tag: string
  params?: Record<string, unknown>
  props?: Record<string, unknown>
}

export interface WaitForObservationToolArgs {
  page?: string
  match?: ObservationMatch
  timeoutMs?: number
}

/**
 * agent 调用页面 `defineExpose` 暴露方法的入参。
 * - 不传 page：调用当前页（最常见）；传 page：调用已渲染的指定 tag。
 * - name：必须与 manifest.pages[].exposes[].name 完全匹配，否则 chat-client 拒绝执行。
 * - args：方法实参数组（JSON 可序列化优先）。按方法签名顺序传入；方法需要参数时必须提供，
 *   缺失会以 undefined 调用而失败（当前实现不做签名 reconcile）。
 */
export interface CallPageMethodToolArgs {
  page?: string
  name: string
  args?: unknown[]
  timeoutMs?: number
}

/**
 * `propose_plan` 入参：把复杂任务拆成可逐轮推进的步骤。
 * 调用后本轮 run 以 `completed` 收尾（`chat.plan` 下发计划卡），用户确认前不得操作页面。
 */
export interface ProposePlanToolArgs {
  /** 一句话说明这个计划要达成什么 */
  summary: string
  /** 有序步骤（1~8 条）；每步一句话即可，不要写实现细节 */
  steps: Array<{
    title: string
    detail?: string
  }>
}

/**
 * `revise_plan` 入参：在当前计划上做**增量修订**（而不是换一份新计划）。
 *
 * 语义（服务端按 `step.id` 合并，规则见 `add-interactive-plan-revision`）：
 * - 带 `id` 且命中当前计划的步骤 = **原地修改**（默认保留该步骤状态，`done` 仍是 `done`）；
 * - 不带 `id` 的步骤 = **新增**（服务端分配新的稳定标识，状态 `pending`）；
 * - 当前计划里未出现在 `steps` 中的步骤 = **删除**；
 * - 顺序以 `steps` 为准（天然支持调整顺序）。
 *
 * 因此 `steps` 必须是**修订后的完整步骤序列** —— 未改动的步骤也要原样带回它的 `id` 与标题，
 * 否则会被当成"删掉旧的 + 加一个新的"，进度就丢了。
 */
export interface RevisePlanToolArgs {
  /** 一句话说明这次改了什么（给用户看的变更摘要；可省略） */
  note?: string
  /** 修订后的目标；省略 = 沿用当前计划的 summary */
  summary?: string
  steps: Array<{
    /** 要原地修改的既有步骤 id（`step-N`）；新增步骤不要带 */
    id?: string
    title: string
    detail?: string
    /** 该步骤原本已完成（`done`），但这次改动需要重做 → 置回 `pending` */
    reopen?: boolean
  }>
}

/**
 * `handoff_step` 入参：把计划的某一步**交回给用户手做**（agent 做不了的那一步）。
 *
 * 什么时候用（判据，不是感觉）：
 * - 动作是写后端的（保存 / 提交 / 删除 / 审批），或**页面能力清单里没有**对应方法；
 * - 需要人本身才能完成的（扫码、验证码、线下动作）；
 * - `call_page_method` 返回权限不足 / 校验失败 —— 不要反复试，交回用户。
 *
 * 带 `issue` 时是第二种用法：**校验发现用户上一次没做对**，请他在页面重做
 * （该步回到 `waiting-user` 并显示原因，不会被静默跳过）。
 *
 * 调用后本轮 run 以 `waiting-user` 收尾（下发的计划卡上该步为 `waiting-user`），
 * 用户点「我已完成 / 我已重做，下一步」→ `chat.send({ planId, stepDoneId })` 起下一轮。
 */
export interface HandoffStepToolArgs {
  /** 要交接的步骤 id（当前计划里的 `step-N`） */
  stepId: string
  /** 给用户的**操作指引**：在哪个页面、点什么、做到什么算完成（必填；别写"你去做一下"） */
  instruction: string
  /** 校验发现的问题（可选）：带上 = 这一步没做成 / 做错了，请用户重做 */
  issue?: {
    /** 哪里不对（给用户看的一句话） */
    reason: string
    /** 期望做成什么样（可选） */
    expected?: string
  }
}

/**
 * `ask_user` 入参：信息不足时向用户提问（一次只问一个问题）。
 * 调用后本轮 run 以 `completed` 收尾（`chat.ask` 下发问题卡），用户回答后起下一轮。
 */
export interface AskUserToolArgs {
  question: string
  /** 2~5 个可选项（用户也可以自由输入） */
  options: string[]
}

/**
 * `finish_turn` 入参：本轮进度交接。
 * 任何一轮都可以用它优雅收尾；`doneAll: true` 表示整个任务完成。
 */
export interface FinishTurnToolArgs {
  /** 本轮做了什么 / 现在的状态（给用户看的一句话） */
  summary: string
  /** 已完成的计划步骤 id 列表（可选） */
  done?: string[]
  /** 剩余的计划步骤 id 列表（可选） */
  remaining?: string[]
  /** 整个任务是否已完成 */
  doneAll?: boolean
}

export type ToolArgs =
  | RenderToolArgs
  | WaitForObservationToolArgs
  | CallPageMethodToolArgs
  | ProposePlanToolArgs
  | RevisePlanToolArgs
  | HandoffStepToolArgs
  | AskUserToolArgs
  | FinishTurnToolArgs

export interface ToolCallMessage {
  t: 'tool.call'
  id: string
  name: ToolName
  args: ToolArgs
  timeoutMs: number
}

export interface ChatDoneMessage {
  t: 'chat.done'
  steps: number
  /** 本轮 run 开始时间（ms epoch）；缺省时 UI 不显示耗时（兼容旧 server） */
  startedAt?: number
  /** 本轮 run 总耗时 ms —— 过程区折叠标题的「共 N 步 · X.Xs」用它 */
  durationMs?: number
  /**
   * 本轮的结束方式（收尾工具名）：
   * - `propose_plan`：已给出计划，等用户确认
   * - `handoff_step`：某一步已交回用户手做（计划卡上该步为 `waiting-user`），等用户点「我已完成，下一步」
   * - `ask_user`：已给出问题，等用户回答
   * - `finish_turn`：进度已交接（可能还有剩余步骤）
   * - 缺省：模型自然结束（或步数用尽被降级为暂停）
   */
  endedBy?: TurnEndToolName
}

/**
 * 计划卡片载荷（`propose_plan` / `revise_plan` / `handoff_step` 收尾时下发）。
 * 用户点「开始执行」→ `chat.send({ text, planId })`；点「修改计划」→
 * `chat.send({ text: '<修改意见>', revisePlanId: planId })`；点「重新生成计划」→ 直接发新的任务描述；
 * 点「我已完成，下一步」→ `chat.send({ text, planId, stepDoneId })`（`add-plan-manual-steps`）。
 *
 * 修订（`revise_plan`）**不改 planId**：卡片在原位更新，`revision` 递增、`revisedAt` / `note` 说明改动，
 * 用户看到的是"这份计划被改了"而不是"旧卡作废 + 冒出一张新卡"。
 *
 * 人工步骤（`handoff_step`）同样**不改 planId**：卡片原地更新，`steps` 里出现
 * `status: 'waiting-user'` 的那一步就是"现在轮到你了"（带 `instructions` 指引，
 * 若带 `issue` 则是"上次没做成，请重做"）。客户端不需要新增顶层字段。
 */
export interface ChatPlanMessage {
  t: 'chat.plan'
  planId: string
  summary: string
  steps: PlanStep[]
  /** 本卡片产生时的模式（UI 可据此显示"计划模式"） */
  createdAt: number
  /**
   * 服务端权威的计划状态。
   * 客户端**只跟随**它（不自行推断）：修订会让已批准的计划回到 `proposed`（需重新确认），
   * 本地若按"同 planId 就是同一份"处理就会漂移。
   */
  status: 'proposed' | 'approved'
  /** 第几版（首版 1；每次修订 +1） */
  revision?: number
  /** 最近一次修订时间 */
  revisedAt?: number
  /** 最近一次修订的变更摘要（如「修改 1 步（第 3 步：导出 CSV）；新增 1 步」） */
  note?: string
}

/**
 * 提问卡片载荷（`ask_user` 收尾时下发）。
 * 用户点选项 / 直接打字 → `chat.send({ text, questionId })`。
 */
export interface ChatAskMessage {
  t: 'chat.ask'
  questionId: string
  question: string
  /** 2~5 个可选项（点选即作为回答发送） */
  options: string[]
  askedAt: number
}

export interface ChatErrorMessage {
  t: 'chat.error'
  message: string
}

export interface PongMessage {
  t: 'pong'
}

export type ServerMessage =
  | SessionReadyMessage
  | ChatModeMessage
  | ChatTextMessage
  | AgentStepMessage
  | ToolCallMessage
  | ChatPlanMessage
  | ChatAskMessage
  | ChatDoneMessage
  | ChatErrorMessage
  | PongMessage
