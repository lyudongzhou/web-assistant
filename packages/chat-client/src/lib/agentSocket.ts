// WebSocket-based agent client：双向 RPC（tool.call ↔ tool.result）+ 观察转发。
// 符合 @webassistant/protocol/websocket 的 ClientMessage / ServerMessage 联合类型。
//
// 连接管理：sessionId 持久化（sessionStorage）+ 自动重连退避 + 心跳 ping。
import type {
  ClientMessage,
  ServerMessage,
  ToolResultMessage,
} from '@webassistant/protocol/websocket'
import type { NavigationSource } from '@webassistant/protocol/session'

export const DEFAULT_WS_BASE = '/ws'
export const DEFAULT_WC_BASE = '/wc'

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
}

export interface AgentSocket {
  /** 建立连接 + 发送 session.hello；返回 sessionId（新建或恢复） */
  connect(): Promise<{ sessionId: string; resumed: boolean }>
  /** 发送工具执行结果（render accepted / wait_for_observation 返回） */
  sendToolResult(result: ToolResultMessage): void
  /** 转发页面导航事件 */
  sendPageNavigated(payload: { tag: string; params: Record<string, unknown>; source: NavigationSource; navigationId?: string; title?: string }): void
  /** 转发页面网络观察事件（仅 4 种网络类型会被发送） */
  sendObservation(observation: { type: string }): void
  sendPageData(snapshot: { page?: string; source: string; data: unknown; truncated: boolean; at: number }): void
  /** 转发页面 Vue `defineEmits` 事件（通知面第二条腿） */
  sendPageEmit(payload: { tag: string; event: string; payload?: unknown; at?: number }): void
  /** 转发当前页 `defineExpose` 能力清单（agent call_page_method 的依据） */
  sendPageExposed(payload: { tag: string; keys: string[] }): void
  /** 发送 chat（用户消息） */
  sendChat(text: string): void
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

const SESSION_ID_KEY = 'webassistant.sessionId'
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

function loadSessionId(): string | null {
  try { return sessionStorage.getItem(SESSION_ID_KEY) } catch { return null }
}

function saveSessionId(id: string): void {
  try { sessionStorage.setItem(SESSION_ID_KEY, id) } catch { /* ignore */ }
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
  } = options

  let ws: WebSocket | null = null
  let sessionId: string | null = loadSessionId()
  let connected = false
  let disposed = false
  let state: AgentSocketState = 'disconnected'
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  let readyResolve: ((v: { sessionId: string; resumed: boolean }) => void) | null = null
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
      sessionId = msg.sessionId
      saveSessionId(sessionId)
      connected = true
      reconnectAttempt = 0
      setState('connected')
      startHeartbeat()
      if (readyResolve) {
        readyResolve({ sessionId: msg.sessionId, resumed: msg.resumed })
        readyResolve = null
        readyReject = null
      }
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null }
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
      const hello: Extract<ClientMessage, { t: 'session.hello' }> = {
        t: 'session.hello', wcBase, manifestVersion,
      }
      if (sessionId) hello.sessionId = sessionId
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

  function connect(): Promise<{ sessionId: string; resumed: boolean }> {
    if (connected && sessionId) return Promise.resolve({ sessionId, resumed: true })
    return new Promise<{ sessionId: string; resumed: boolean }>((resolve, reject) => {
      if (readyReject) readyReject(new Error('连接被重新触发'))
      readyResolve = resolve
      readyReject = reject
      open()
    })
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
    sendToolResult(result) { sendRaw(result) },
    sendPageNavigated(payload) {
      sendRaw({ t: 'page.navigated', tag: payload.tag, params: payload.params,
        source: payload.source, navigationId: payload.navigationId, title: payload.title })
    },
    sendObservation(observation) {
      // 只转发 4 种网络观察（runtime 只产出这几种；page.visible 等无 wire 通道）
      const NETWORK_TYPES: readonly string[] = [
        'page.network.request', 'page.network.response', 'page.network.error', 'page.network.timeout',
      ]
      if (!NETWORK_TYPES.includes(observation.type)) return
      const { type, ...rest } = observation
      sendRaw({ t: type as ClientMessage['t'], ...rest } as ClientMessage)
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
    sendChat(text) { sendRaw({ t: 'chat.send', text }) },
    sendCancel() { sendRaw({ t: 'chat.cancel' }) },
    sendPing() { sendRaw({ t: 'ping' }) },
    disconnect() { doDisconnect() },
    get connected() { return connected },
    get sessionId() { return sessionId },
    get state() { return state },
  }
}