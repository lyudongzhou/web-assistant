// 对话状态机（WebSocket 版）：消息列表 / loading / 流式拼接 / render 指令回调 / tool.call 应答。
// 只管对话，不知道 runtime 的存在 —— 渲染由 useRuntimeHost 负责，两者在组件里接线。
//
// 通信链路：agentSocket.sendChat → WS → agent-server → AgentService.run()
//           ← WS ← chat.text(结果/思考两条 channel) / agent.step(过程) / tool.call / chat.done / chat.error
//
// ⚠️ 过程与结果**必须**落成不同 kind 的消息（见 lib/chatTrace.ts）：
// 早期实现把过程行以 `\n> …\n` 追加进**同一条** assistant 消息的 content 里，
// 结果 UI 只拿到一根字符串，思考过程与结果在界面上无法分离 —— 那正是本次修复的根因。
import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import type {
  AgentStepMessage,
  ServerMessage,
  ToolResultMessage,
  RenderToolArgs,
  CallPageMethodToolArgs,
  ActivityAckData,
  WelcomePayload,
} from '@webassistant/protocol/websocket'
import type { AgentSocket } from '../lib/agentSocket.js'
import type { ChatMessage } from '../types.js'
import {
  appendStream,
  pushStep,
  splitMessages,
  summarizeTrace,
  type StreamChannel,
  type TraceSummary,
} from '../lib/chatTrace.js'

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
  /** 全部消息（结果气泡 + 过程条目，按发生顺序） */
  messages: Ref<ChatMessage[]>
  /**
   * 结果气泡（`kind` 缺省或 `'message'`）—— 只渲染这些进对话气泡区。
   * 与 `trace` 互补，两者合起来正好是 `messages`（见 lib/chatTrace.ts 的 `splitMessages`）。
   */
  bubbles: ComputedRef<ChatMessage[]>
  /** 过程条目（步骤 / 思考 / 错误）—— 渲染进「过程区」，默认折叠 */
  trace: ComputedRef<ChatMessage[]>
  /** 过程区折叠标题的摘要（步数 / 进行中 / 失败 / 本轮耗时） */
  traceSummary: ComputedRef<TraceSummary>
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
  /**
   * 流式游标 —— **按通道各持一个**（结果 / 思考）。
   * 共用一个游标就会出现「思考的 delta 追加进了结果气泡」这类串行错配。
   * `-1` = 该通道这一段流还没开始。
   */
  const cursors: Record<StreamChannel, number> = { message: -1, reasoning: -1 }
  /** 本轮 run 总耗时（`chat.done.durationMs`），供过程区标题显示 */
  const turnDurationMs = ref<number | undefined>(undefined)

  /** 一段流结束（新一段另起气泡） */
  function endStreams(): void {
    cursors.message = -1
    cursors.reasoning = -1
  }

  /** 追加一段流式文本到指定通道（结果 / 思考） */
  function appendStreamText(channel: StreamChannel, delta: string): void {
    cursors[channel] = appendStream(messages.value, cursors[channel], channel, delta)
  }

  /** 过程区条目（不参与流式游标：步骤独立成条，可反复就地结算） */
  function appendStep(step: AgentStepMessage): void {
    pushStep(messages.value, step)
  }

  function handleServerMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'session.ready':
        // 握手时 agent 下发的欢迎载荷（渲染区欢迎页据此渲染能力卡片）
        welcome.value = message.welcome ?? null
        sessionReady.value = true
        break
      case 'chat.text':
        // channel 缺省 = 结果正文（兼容旧 server）；'reasoning' = 模型思考，独立成栏
        appendStreamText(message.channel === 'reasoning' ? 'reasoning' : 'message', message.delta)
        break
      case 'agent.step':
        // 过程步骤：独立成条 + 按 phase 就地结算 —— 不与结果正文共用游标
        appendStep(message)
        break
      case 'tool.call':
        void handleToolCall(message)
        break
      case 'chat.done':
        loading.value = false
        turnDurationMs.value = message.durationMs
        // 结束当前流：下一次 chat.text 另起一条消息
        // （server 主动推送的欢迎语等在「上一轮结束后」到达，必须另起气泡而不是追加）
        endStreams()
        break
      case 'chat.error':
        // 错误进过程区：结果气泡只放"答复"，把 run 级失败混进去会让人以为那是 agent 的回答
        messages.value.push({ role: 'assistant', content: message.message, kind: 'error', at: Date.now() })
        loading.value = false
        endStreams()
        break
    }
  }

  async function handleToolCall(message: Extract<ServerMessage, { t: 'tool.call' }>): Promise<void> {
    const socket = options.socket()
    if (!socket) return

    // render 工具：收到即 ack「已完成」（server 只等 ack，不等页面数据就绪）
    if (message.name === 'render') {
      // ⚠️ 这里**不再**渲染「正在打开页面…」：过程文案唯一来源是 server 的 `agent.step`
      //（带目标、带起止与耗时）。客户端再插一行 = 同一个动作在过程区出现两遍。
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
      messages.value.push({ role: 'assistant', content: '[无法连接 agent-server]', kind: 'error', at: Date.now() })
      return
    }
    messages.value.push({ role: 'user', content: message, at: Date.now() })
    loading.value = true
    endStreams()
    turnDurationMs.value = undefined
    socket.sendChat(message)
  }

  function cancel(): void {
    options.socket()?.sendCancel()
    loading.value = false
  }

  function reset(): void {
    messages.value = []
    endStreams()
    turnDurationMs.value = undefined
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

  // ---- 过程 / 结果的派生视图 ----
  // UI 只关心这两栏；切分规则在 lib/chatTrace.ts（纯逻辑、可单测），这里只做响应式包装。
  // 一次切分派生出两个视图，避免两处各扫一遍列表。
  const split = computed(() => splitMessages(messages.value))
  const bubbles = computed(() => split.value.bubbles)
  const trace = computed(() => split.value.trace)
  /** 过程区折叠标题：步数 / 进行中 / 失败 / 本轮耗时 */
  const traceSummary = computed(() => summarizeTrace(trace.value, turnDurationMs.value))

  return {
    messages,
    bubbles,
    trace,
    traceSummary,
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
