// Agent ↔ chat-client 的 WebSocket 协议。
// 所有消息带 t，双方对未知 t 应忽略并记录日志，以便协议向前演进。

import type {
  ObservationMatch,
  PageDataSnapshot,
  PageNetworkError,
  PageNetworkRequest,
  PageNetworkResponse,
  PageNetworkTimeout,
} from './observation.js'
import type { NavigationSource } from './session.js'

export const CLIENT_MESSAGE = {
  SessionHello: 'session.hello',
  ChatSend: 'chat.send',
  ChatCancel: 'chat.cancel',
  ToolResult: 'tool.result',
  PageNavigated: 'page.navigated',
  PageNetworkRequest: 'page.network.request',
  PageNetworkResponse: 'page.network.response',
  PageNetworkError: 'page.network.error',
  PageNetworkTimeout: 'page.network.timeout',
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

export interface SessionHelloMessage {
  t: 'session.hello'
  sessionId?: string
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

export type PageNetworkRequestMessage = Omit<PageNetworkRequest, 'type'> & { t: 'page.network.request' }
export type PageNetworkResponseMessage = Omit<PageNetworkResponse, 'type'> & { t: 'page.network.response' }
export type PageNetworkErrorMessage = Omit<PageNetworkError, 'type'> & { t: 'page.network.error' }
export type PageNetworkTimeoutMessage = Omit<PageNetworkTimeout, 'type'> & { t: 'page.network.timeout' }
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
  | PageNetworkRequestMessage
  | PageNetworkResponseMessage
  | PageNetworkErrorMessage
  | PageNetworkTimeoutMessage
  | PageEmitMessage
  | PageExposedMessage
  | PingMessage

export interface SessionReadyMessage {
  t: 'session.ready'
  sessionId: string
  resumed: boolean
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

export interface ChatTextMessage {
  t: 'chat.text'
  delta: string
}

export interface AgentStepMessage {
  t: 'agent.step'
  index: number
  text: string
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
