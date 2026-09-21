// WebSocket-based agent client：双向 RPC（tool.call ↔ tool.result）+ 观察转发。
// 符合 @webassistant/protocol/websocket 的 ClientMessage / ServerMessage 联合类型。
//
// 连接管理：**会话 = 连接**（不持久化任何会话标识）+ 自动重连退避 + 心跳 ping。
//
// 会话语义：每次握手（session.hello → session.ready）都由服务端新建会话；
// 客户端不保存、不复用 sessionId —— 刷新页面或断线重连 = 全新会话（由 `onSessionReset` 通知上层重置 UI）。
import type {
  ClientMessage,
  ServerMessage,
  ToolResultMessage,
} from '@webassistant/protocol/websocket'
import type { NavigationSource } from '@webassistant/protocol/session'
import type { AgentMode } from '@webassistant/protocol'

export const DEFAULT_WS_BASE = '/ws'
export const DEFAULT_WC_BASE = '/wc'

/**
 * 本轮的附加指令（对应 `chat.send` 的可选字段）：
 * - `mode`：模式请求值（`auto` / `act` / `plan`）—— 用户在 ModeSwitch 上的选择
 * - `planId`：确认某个计划（计划卡「开始执行」）
 * - `questionId`：回答某个提问（问题卡选项 / 直接打字）
 */
export interface ChatSendOptions {
  mode?: AgentMode
  /** 确认某个计划（计划卡「开始执行」） */
  planId?: string
  /** 对本轮的"修改计划"意见（计划卡「修改计划」）：值为当前计划的 planId，`text` 即意见 */
  revisePlanId?: string
  questionId?: string
}

export type AgentSocketState = 'connecting' | 'connected' | 'disconnected'
export type AgentSocketEventHandler = (message: ServerMessage) => void
export type AgentSocketStateChangeHandler = (state: AgentSocketState) => void

export interface AgentSocketOptions {
  /** WS 地址前缀（默认 '/ws'） */
  wsBase?: string
  /** 静态资源基础路径（session.hello 带给 server 定位 manifest/产物） */
  wcBase?: string
  /** manifest 版本号（session.hello 需要，防止客户端/服务端版本漂移） */
  manifestVersion?: number
  /** 是否自动重连（默认 true） */
  autoReconnect?: boolean
  /** 心跳间隔 ms（默认 30 000） */
  heartbeatMs?: number
  /** 服务端消息回调 */
  onMessage?: AgentSocketEventHandler
  /** 连接状态变化回调 */
  onStateChange?: AgentSocketStateChangeHandler
  /**
   * 「已开始新会话」回调：**第 2 次及以后的握手**（掉线重连、主动新会话）触发。
   * 会话 = 连接，所以重连必然是新会话 —— 上层据此清空聊天区并提示用户。
   */
  onSessionReset?: (sessionId: string) => void
}

export interface AgentSocket {
  /** 建立连接 + 发送 session.hello；返回本次连接新建的 sessionId */
  connect(): Promise<{ sessionId: string }>
  /**
   * 主动开始新会话：断开当前连接（不触发自动重连）后立刻重建 —— 服务端会新建会话。
   * 用途：UI 的「新会话」入口（等价于刷新页面，但不必关标签页）。
   */
  startNewSession(): Promise<{ sessionId: string }>
  /** 发送工具执行结果（render accepted / wait_for_observation 返回） */
  sendToolResult(result: ToolResultMessage): void
  /** 转发页面导航事件 */
  sendPageNavigated(payload: { tag: string; params: Record<string, unknown>; source: NavigationSource; navigationId?: string; title?: string }): void
  /** 转发**显式上报**的数据快照（调用方 apiBus.report → ws page.data） */
  sendPageData(snapshot: { page?: string; source: string; data: unknown; truncated: boolean; at: number }): void
  /** 转发页面 Vue `defineEmits` 事件（通知面第二条腿） */
  sendPageEmit(payload: { tag: string; event: string; payload?: unknown; at?: number }): void
  /** 转发当前页 `defineExpose` 能力清单（agent call_page_method 的依据） */
  sendPageExposed(payload: { tag: string; keys: string[] }): void
  /** 发送 chat（用户消息）；`options` 用于本轮的附加指令（模式 / 确认计划 / 回答提问） */
  sendChat(text: string, options?: ChatSendOptions): void
  /** 取消当前 agent run */
  sendCancel(): void
  /** 心跳 ping（通常由内部定时器自动发送） */
  sendPing(): void
  /** 断开连接并停止重连 */
  disconnect(): void
  /** 是否处于已连接状态 */
  readonly connected: boolean
  /** 当前 sessionId（connect 后可用） */
  readonly sessionId: string | null
  /** 连接状态 */
  readonly state: AgentSocketState
}

// ── 辅助 ──────────────────────────────────────────────────────────────

const HANDSHAKE_TIMEOUT = 10_000
const MAX_RECONNECT_DELAY = 30_000

function wsUrl(base: string): string {
  // 支持绝对地址：ws:// / wss:// / http:// / https://（http(s):// 自动转 ws(s)://），
  // 否则按相对路径拼当前 host。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) {
    return base.replace(/^http/i, 'ws')
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${base}`
}

// ── 工厂 ──────────────────────────────────────────────────────────────

export function createAgentSocket(options: AgentSocketOptions): AgentSocket {
  const {
    wsBase = DEFAULT_WS_BASE,
    wcBase = DEFAULT_WC_BASE,
    manifestVersion = 2,
    autoReconnect = true,
    heartbeatMs = 30_000,
    onMessage,
    onStateChange,
    onSessionReset,
  } = options

  let ws: WebSocket | null = null
  /** 本次连接的会话 id（由服务端在 session.ready 下发；**不持久化**，断开即失效） */
  let sessionId: string | null = null
  /** 是否已经完成过一次握手：第 2 次起视为「重连 = 新会话」，通知上层重置 UI */
  let handshaked = false
  let connected = false
  let disposed = false
  let state: AgentSocketState = 'disconnected'
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  let readyResolve: ((v: { sessionId: string }) => void) | null = null
  let readyReject: ((r: Error) => void) | null = null

  function setState(next: AgentSocketState): void {
    if (state === next) return
    state = next
    onStateChange?.(next)
  }

  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => { sendRaw({ t: 'ping' }) }, heartbeatMs)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  }

  function scheduleReconnect(): void {
    if (!autoReconnect || disposed) return
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open() }, delay)
  }

  function sendRaw(msg: ClientMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function handleServerMessage(data: unknown): void {
    let msg: ServerMessage
    try { msg = JSON.parse(String(data)) as ServerMessage } catch { return }
    if (msg.t === 'session.ready') {
      const isReset = handshaked
      sessionId = msg.sessionId
      handshaked = true
      connected = true
      reconnectAttempt = 0
      setState('connected')
      startHeartbeat()
      if (readyResolve) {
        readyResolve({ sessionId: msg.sessionId })
        readyResolve = null
        readyReject = null
      }
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null }
      // 第 2 次及以后的握手 = 新会话（会话 = 连接）：通知上层清空聊天区
      if (isReset) onSessionReset?.(msg.sessionId)
    }
    onMessage?.(msg)
  }

  function open(): void {
    if (disposed) return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    setState('connecting')
    const socket = new WebSocket(wsUrl(wsBase))
    ws = socket

    socket.onopen = () => {
      // 会话 = 连接：hello **不带** sessionId（服务端每次新建会话）
      const hello: Extract<ClientMessage, { t: 'session.hello' }> = {
        t: 'session.hello', wcBase, manifestVersion,
      }
      sendRaw(hello)
    }
    socket.onmessage = (ev) => handleServerMessage(ev.data)
    socket.onerror = () => {
      if (readyReject) { readyReject(new Error('WebSocket 连接失败')); readyReject = null; readyResolve = null }
    }
    socket.onclose = () => {
      if (ws === socket) ws = null
      connected = false
      setState('disconnected')
      stopHeartbeat()
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null }
      if (readyReject) { readyReject(new Error('WebSocket 连接关闭')); readyReject = null; readyResolve = null }
      scheduleReconnect()
    }
    handshakeTimer = setTimeout(() => {
      if (!connected && ws === socket) {
        readyReject?.(new Error(`WebSocket 握手超时（${HANDSHAKE_TIMEOUT}ms）`))
        readyReject = null; readyResolve = null
        socket.close()
      }
    }, HANDSHAKE_TIMEOUT)
  }

  function connect(): Promise<{ sessionId: string }> {
    if (connected && sessionId) return Promise.resolve({ sessionId })
    return new Promise<{ sessionId: string }>((resolve, reject) => {
      if (readyReject) readyReject(new Error('连接被重新触发'))
      readyResolve = resolve
      readyReject = reject
      open()
    })
  }

  /**
   * 主动开始新会话：断开当前连接（摘掉 onclose，避免触发自动重连与「已断开」噪音）后重建连接。
   * 服务端对新的 hello 必然新建会话，客户端不发送任何旧会话标识。
   */
  function startNewSession(): Promise<{ sessionId: string }> {
    if (ws) {
      const socket = ws
      ws = null
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
    }
    connected = false
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null }
    stopHeartbeat()
    return connect()
  }

  function doDisconnect(): void {
    disposed = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null }
    stopHeartbeat()
    if (ws) {
      const s = ws; ws = null
      s.onclose = null; s.close()
    }
    connected = false
    setState('disconnected')
  }

  // ---- 返回 ----
  return {
    connect,
    startNewSession,
    sendToolResult(result) { sendRaw(result) },
    sendPageNavigated(payload) {
      sendRaw({ t: 'page.navigated', tag: payload.tag, params: payload.params,
        source: payload.source, navigationId: payload.navigationId, title: payload.title })
    },
    sendPageData(snapshot) {
      sendRaw({ t: 'page.data' as ClientMessage['t'], ...snapshot } as ClientMessage)
    },
    sendPageEmit(payload) {
      sendRaw({ t: 'page.emit', ...payload } as ClientMessage)
    },
    sendPageExposed(payload) {
      sendRaw({ t: 'page.exposed', ...payload } as ClientMessage)
    },
    sendChat(text, options) {
      // 只带非空字段：空串/undefined 会让服务端以为"显式指定了空模式"（模式解析会回落，
      // 但 planId/questionId/revisePlanId 的配对语义会变得含糊）
      sendRaw({
        t: 'chat.send',
        text,
        ...(options?.mode ? { mode: options.mode } : {}),
        ...(options?.planId ? { planId: options.planId } : {}),
        ...(options?.revisePlanId ? { revisePlanId: options.revisePlanId } : {}),
        ...(options?.questionId ? { questionId: options.questionId } : {}),
      })
    },
    sendCancel() { sendRaw({ t: 'chat.cancel' }) },
    sendPing() { sendRaw({ t: 'ping' }) },
    disconnect() { doDisconnect() },
    get connected() { return connected },
    get sessionId() { return sessionId },
    get state() { return state },
  }
}