// 对话状态机（WebSocket 版）：消息列表 / loading / 流式拼接 / render 指令回调 / tool.call 应答。
// 只管对话，不知道 runtime 的存在 —— 渲染由 useRuntimeHost 负责，两者在组件里接线。
//
// 通信链路：agentSocket.sendChat → WS → agent-server → AgentService.run()
//           ← WS ← chat.text / agent.step / tool.call / chat.done / chat.error
import { ref, shallowRef, type Ref } from 'vue'
import type {
  ServerMessage,
  ToolResultMessage,
  RenderToolArgs,
  CallPageMethodToolArgs,
  ActivityAckData,
  WelcomePayload,
} from '@webassistant/protocol/websocket'
import type { AgentSocket } from '../lib/agentSocket.js'
import type { ChatMessage } from '../types.js'

export interface UseAgentChatOptions {
  /** 已连接的 agentSocket（由调用方创建并管理生命周期） */
  socket: () => AgentSocket | null
  /**
   * 收到 render 指令（agent 让你渲染某个页面）。
   * ⚠️ 参数是 RenderToolArgs（{ tag, params?, props? }），不是 AgentRenderEvent。
   */
  onRender: (data: RenderToolArgs) => void | Promise<void>
  /**
   * 收到 call_page_method 指令（agent 调用当前页 expose 的方法）。
   * 返回值结构化：成功 { ok:true, value }，失败 { ok:false, error }。
   * chat-client 仅做协议转译：执行 + tool.result 回流，不参与业务。
   */
  onCallPageMethod: (data: CallPageMethodToolArgs) => Promise<
    | { ok: true; value: unknown; async: boolean }
    | { ok: false; error: string }
  >
}

export interface UseAgentChatReturn {
  messages: Ref<ChatMessage[]>
  loading: Ref<boolean>
  /** 连接握手（session.ready）时 agent 下发的欢迎载荷，供渲染区欢迎页使用；未下发时为 null */
  welcome: Ref<WelcomePayload | null>
  /**
   * 是否已收到 `session.ready`（握手完成）。
   * 欢迎页用它判断「欢迎内容的数据源之一已 settle」——未就绪时显示加载态而不是空态提示。
   */
  sessionReady: Ref<boolean>
  /** 发送用户消息（会通过 socket.sendChat 发出） */
  send: (input: string) => void
  /** 取消当前 agent run */
  cancel: () => void
  reset: () => void
  /**
   * 开始新会话（会话 = 连接）：清空消息并主动重连（服务端新建会话）。
   * 等价于刷新页面但不必关标签页；供 UI 的「新会话」入口调用。
   */
  startNewSession: () => void
  /** 供外部把 socket.onMessage 回调接到这里（分发 chat.text / tool.call / done / error） */
  _handleServerMessage: (message: ServerMessage) => void
  /** 供外部把 socket.onSessionReset 回调接到这里（掉线重连 = 新会话 → 清空聊天区并提示） */
  _handleSessionReset: () => void
}

export function useAgentChat(options: UseAgentChatOptions): UseAgentChatReturn {
  const messages = ref<ChatMessage[]>([])
  const loading = ref(false)
  const welcome = shallowRef<WelcomePayload | null>(null)
  /** 是否已收到 `session.ready`（握手完成：欢迎载荷有无都已确定，供欢迎页退出加载态） */
  const sessionReady = ref(false)
  /** 当前正在流式接收的 assistant 消息下标，-1 表示还没开始 */
  let streamingIndex = -1

  function appendAssistant(text: string): void {
    if (streamingIndex < 0) {
      messages.value.push({ role: 'assistant', content: '' })
      streamingIndex = messages.value.length - 1
    }
    const current = messages.value[streamingIndex]
    if (current) current.content += text
  }

  function handleServerMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'session.ready':
        // 握手时 agent 下发的欢迎载荷（渲染区欢迎页据此渲染能力卡片）
        welcome.value = message.welcome ?? null
        sessionReady.value = true
        break
      case 'chat.text':
        appendAssistant(message.delta)
        break
      case 'agent.step':
        appendAssistant(`\n> ${message.text}\n`)
        break
      case 'tool.call':
        void handleToolCall(message)
        break
      case 'chat.done':
        loading.value = false
        // 结束当前流式气泡：下一次 chat.text 另起一条消息
        // （server 主动推送的欢迎语等在「上一轮结束后」到达，必须另起气泡而不是追加）
        streamingIndex = -1
        break
      case 'chat.error':
        appendAssistant(`\n[错误] ${message.message}`)
        loading.value = false
        streamingIndex = -1
        break
    }
  }

  async function handleToolCall(message: Extract<ServerMessage, { t: 'tool.call' }>): Promise<void> {
    const socket = options.socket()
    if (!socket) return

    // render 工具：收到即 ack「已完成」（server 只等 ack，不等页面数据就绪）
    if (message.name === 'render') {
      appendAssistant(`\n> 正在打开页面...\n`)
      const renderArgs = message.args as RenderToolArgs
      // 与那次 tool 调用 in-band 对应；只表示导航请求已受理，不代表页面/数据就绪
      const ack: ActivityAckData = { status: 'done', target: renderArgs.tag }
      const result: ToolResultMessage = {
        t: 'tool.result',
        id: message.id,
        ok: true,
        data: ack,
      }
      socket.sendToolResult(result)
      // 传入 RenderToolArgs（{ tag, params?, props? }）—— 已由 protocol 定义
      void Promise.resolve(options.onRender(renderArgs))
      return
    }

    // wait_for_observation 工具：server 内部通过 session.waitForObservation() 阻塞等待，
    // 不走 RPC —— client 收到此 tool.call 是防御性处理，返回空结果即可。
    // 观察事件通过 page.data / page.emit 消息独立转发到 server。
    if (message.name === 'wait_for_observation') {
      appendAssistant(`\n> 等待页面数据...\n`)
      const result: ToolResultMessage = {
        t: 'tool.result',
        id: message.id,
        ok: true,
        data: { observations: [] },
      }
      socket.sendToolResult(result)
      return
    }

    // call_page_method 工具：执行当前页 expose 的方法 → 回 tool.result
    if (message.name === 'call_page_method') {
      const args = message.args as CallPageMethodToolArgs
      const targetLabel = args.page ? `<${args.page}>` : '当前页'
      appendAssistant(`\n> 正在调用 ${targetLabel}.${args.name}()...\n`)
      // server 端 rpc.call 只接受一次 result。call_page_method 必须等执行结果（不等用户就无意义），
      // 所以不预 ack，拿到结果再统一回一条 tool.result。失败/超时由 server 端 TOOL_CALL_TIMEOUT_MS 兜底。
      const settled: ToolResultMessage = await options
        .onCallPageMethod(args)
        .then(
          (r): ToolResultMessage => {
            if (!r.ok) return { t: 'tool.result', id: message.id, ok: false, error: r.error }
            // 成功：Promise 已 resolve，或非 Promise 同步返回。有返回值才带上；无则只报成功。
            const ack: ActivityAckData = {
              status: 'success',
              target: args.name,
              async: r.async,
              ...(r.value !== undefined ? { value: r.value } : {}),
            }
            return { t: 'tool.result', id: message.id, ok: true, data: ack }
          },
          (cause): ToolResultMessage => ({
            t: 'tool.result',
            id: message.id,
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        )
      socket.sendToolResult(settled)
      return
    }

    // 未知工具
    const result: ToolResultMessage = {
      t: 'tool.result',
      id: message.id,
      ok: false,
      error: `不支持的工具: ${message.name}`,
    }
    socket.sendToolResult(result)
  }

  function send(input: string): void {
    const message = input.trim()
    if (!message || loading.value) return
    const socket = options.socket()
    if (!socket || !socket.connected) {
      messages.value.push({ role: 'assistant', content: '[无法连接 agent-server]' })
      return
    }
    messages.value.push({ role: 'user', content: message })
    loading.value = true
    streamingIndex = -1
    socket.sendChat(message)
  }

  function cancel(): void {
    options.socket()?.sendCancel()
    loading.value = false
  }

  function reset(): void {
    messages.value = []
    streamingIndex = -1
    loading.value = false
  }

  /**
   * 掉线重连 / 主动新会话：清空聊天区并提示。
   * 会话 = 连接 ⇒ 重连必然是新会话，旧气泡留着会造成「旧记录 + 无记忆」的错位观感。
   */
  function handleSessionReset(): void {
    const hadMessages = messages.value.length > 0
    reset()
    if (hadMessages) {
      messages.value.push({ role: 'assistant', content: '连接已重置，已开始新会话。' })
    }
  }

  /** 主动开始新会话：清消息 + 提示 → 断开重连（服务端新建会话）。 */
  function startNewSession(): void {
    reset()
    messages.value.push({ role: 'assistant', content: '连接已重置，已开始新会话。' })
    const socket = options.socket()
    if (!socket) return
    socket.startNewSession().catch((cause: unknown) => {
      console.warn('[agentSocket] 新会话连接失败', cause)
    })
  }

  return {
    messages,
    loading,
    welcome,
    sessionReady,
    send,
    cancel,
    reset,
    startNewSession,
    _handleServerMessage: handleServerMessage,
    _handleSessionReset: handleSessionReset,
  }
}
