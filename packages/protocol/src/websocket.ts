// Agent ↔ chat-client 的 WebSocket 协议。
// 所有消息带 t，双方对未知 t 应忽略并记录日志，以便协议向前演进。

import type {
  ObservationMatch,
  PageDataSnapshot,
} from './observation.js'
import type { NavigationSource } from './session.js'

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
  ChatText: 'chat.text',
  AgentStep: 'agent.step',
  ToolCall: 'tool.call',
  ChatDone: 'chat.done',
  ChatError: 'chat.error',
  Pong: 'pong',
} as const

export type ToolName = 'render' | 'wait_for_observation' | 'call_page_method'

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

export type ToolArgs = RenderToolArgs | WaitForObservationToolArgs | CallPageMethodToolArgs

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
  | ChatTextMessage
  | AgentStepMessage
  | ToolCallMessage
  | ChatDoneMessage
  | ChatErrorMessage
  | PongMessage
