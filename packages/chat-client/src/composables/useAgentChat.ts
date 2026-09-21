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
import type { AgentMode, PlanStep } from '@webassistant/protocol'
import type {
  AgentStepMessage,
  ServerMessage,
  ToolResultMessage,
  RenderToolArgs,
  CallPageMethodToolArgs,
  ActivityAckData,
  WelcomePayload,
} from '@webassistant/protocol/websocket'
import type { AgentSocket, ChatSendOptions } from '../lib/agentSocket.js'
import type { ChatMessage } from '../types.js'
import {
  applyAsk,
  applyMode,
  applyPlan,
  approvePlanCard,
  answerAskCard,
  // 纯函数与 composable 暴露的动作同名：这里别名成 *State，避免局部函数把自己递归调回去
  beginPlanRevision as beginPlanRevisionState,
  beginStepCompletion as beginStepCompletionState,
  cancelPlanRevision as cancelPlanRevisionState,
  createTurnState,
  handoffStep as handoffStepState,
  pendingQuestionId,
  settlePlanRevision,
  settleStepCompletion,
  submitPlanRevision as submitPlanRevisionState,
  updatePlanDraft as updatePlanDraftState,
  type AskCard,
  type PlanCard,
  type TurnState,
} from '../lib/turnState.js'
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
  /** 本轮模式判定（`chat.mode`）—— 状态行显示「当前模式 · 判定来源」 */
  mode: ComputedRef<TurnState['mode']>
  /** 当前计划卡（`chat.plan`；批准后 status 变 approved） */
  plan: ComputedRef<PlanCard | null>
  /**
   * 当前"轮到你操作"的那一步（计划里 `status === 'waiting-user'`；没有则 null）。
   * 宿主自写 UI 时用它判断"要不要让用户去页面上操作"。
   */
  handoff: ComputedRef<PlanStep | null>
  /** 当前问题卡（`chat.ask`；回答后有 answer） */
  ask: ComputedRef<AskCard | null>
  /** 发送用户消息（会通过 socket.sendChat 发出） */
  send: (input: string) => void
  /**
   * 发起一轮并显式带上附加指令（用于：确认计划 / 按模式发送）。
   * 与 `send` 的区别：`send` 会自动带上"待回答问题 id"（用户直接打字回答的常见路径）。
   */
  sendWith: (input: string, options?: ChatSendOptions) => void
  /** 确认计划（计划卡的「开始执行」）：发送一条带 planId 的消息 */
  confirmPlan: (plan?: PlanCard) => void
  /** 展开「修改计划」输入框（计划卡的「修改计划」） */
  beginPlanRevision: (planId: string) => void
  /** 修改意见输入变化 */
  updatePlanDraft: (draft: string) => void
  /** 取消修改（收起输入框） */
  cancelPlanRevision: () => void
  /**
   * 提交修改意见（计划卡的「提交修改」）：发送一条带 `revisePlanId` 的消息。
   * 服务端据此把本轮标成"修订轮"，模型调 `revise_plan` 在本计划上增量合并（进度不丢）。
   */
  revisePlan: (input: string, plan?: PlanCard) => void
  /**
   * 人工步骤完成回执（计划卡的「我已完成，下一步」）：发送一条带 `planId` + `stepDoneId` 的消息。
   * 服务端把该步骤标 `done` 后起下一轮，模型**先校验**再继续。
   */
  completeStep: (plan?: PlanCard, stepId?: string) => void
  /** 重新生成计划（全量重来，走 propose_plan） */
  replan: () => void
  /** 切换模式并立刻以新模式发一轮（ModeSwitch 用） */
  sendWithMode: (mode: AgentMode, input: string) => void
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
  /**
   * 回合边界状态（模式 / 计划卡 / 问题卡）。
   * 用 `shallowRef` + 纯函数更新（`lib/turnState.ts`）：状态迁移规则全部可单测，
   * 组件只负责渲染与派发事件。
   */
  const turn = shallowRef<TurnState>(createTurnState())

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
      case 'chat.mode':
        // 每轮开头的判定结果：状态行显示「当前模式 · 判定来源」
        turn.value = applyMode(turn.value, message)
        break
      case 'chat.plan':
        // 计划卡：proposed（等用户确认）/ approved（执行中）**由服务端 `status` 决定**；
        // 修订（同 planId 再次下发）也是走这里 —— 卡片原地刷新，并退出"修改中"
        turn.value = applyPlan(turn.value, message)
        break
      case 'chat.ask':
        // 问题卡：等用户点选项或直接打字；回答后卡片转为「已回答」
        turn.value = applyAsk(turn.value, message)
        break
      case 'tool.call':
        void handleToolCall(message)
        break
      case 'chat.done':
        loading.value = false
        turnDurationMs.value = message.durationMs
        // 本轮结束：修订中的标记收尾（正常路径已由 chat.plan 清掉，这里兜"失败/自然结束"）
        turn.value = settlePlanRevision(turn.value)
        // 人工步骤的"正在校验"同理：不清的话按钮会一直禁用，用户没法重试
        turn.value = settleStepCompletion(turn.value)
        // 结束当前流：下一次 chat.text 另起一条消息
        // （server 主动推送的欢迎语等在「上一轮结束后」到达，必须另起气泡而不是追加）
        endStreams()
        break
      case 'chat.error':
        // 错误进过程区：结果气泡只放"答复"，把 run 级失败混进去会让人以为那是 agent 的回答
        messages.value.push({ role: 'assistant', content: message.message, kind: 'error', at: Date.now() })
        loading.value = false
        turn.value = settlePlanRevision(turn.value)
        turn.value = settleStepCompletion(turn.value)
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
    // 正在等回答时，用户直接打字 = 回答那个问题：带上 questionId 让服务端把问题标记为已回答
    //（不带也能被服务端认下，但带上才能让"旧问题卡"与"新任务"区分开）
    const questionId = pendingQuestionId(turn.value)
    if (questionId) turn.value = answerAskCard(turn.value, message, questionId)
    socket.sendChat(message, { ...(questionId ? { questionId } : {}) })
  }

  /**
   * 带附加指令发送（确认计划 / 指定模式 / 提交修改意见）；与 `send` 共用 loading 与流游标的重置。
   * 返回是否**真的发出去了**（离线 / 正在跑一轮时返回 false）——调用方据此决定要不要做本地状态迁移
   * （例如「提交修改」不能在没发出去的情况下把卡片标成"修改中"）。
   */
  function sendWith(input: string, chatOptions: ChatSendOptions = {}): boolean {
    const message = input.trim()
    if (!message || loading.value) return false
    const socket = options.socket()
    if (!socket || !socket.connected) {
      messages.value.push({ role: 'assistant', content: '[无法连接 agent-server]', kind: 'error', at: Date.now() })
      return false
    }
    messages.value.push({ role: 'user', content: message, at: Date.now() })
    loading.value = true
    endStreams()
    turnDurationMs.value = undefined
    if (chatOptions.planId && !chatOptions.stepDoneId) {
      // 人工步骤回执（`stepDoneId`）同样带 `planId`（服务端用它判过期），但它不是"确认计划" ——
      // 不能顺手把卡片从待确认标成执行中（那会让用户以为计划已被确认，而门禁其实还锁着）。
      turn.value = approvePlanCard(turn.value, chatOptions.planId)
    }
    if (chatOptions.questionId) {
      turn.value = answerAskCard(turn.value, message, chatOptions.questionId)
    }
    socket.sendChat(message, chatOptions)
    return true
  }

  /**
   * 计划卡的「开始执行」。
   * 文案固定成一句"开始执行"（而不是把计划正文塞回去）：计划本身已经在服务端的会话里，
   * 模型靠 prompt 里的「当前计划」段落就知道要做什么，重发一遍反而容易与计划产生分歧。
   */
  function confirmPlan(plan?: PlanCard): void {
    const card = plan ?? turn.value.plan
    if (!card || card.status === 'approved') return
    sendWith('开始执行计划', { planId: card.message.planId })
  }

  /**
   * 计划卡的「我已完成，下一步」（人工步骤）。
   *
   * 两步动作，顺序有讲究：
   * 1. 先发（带 `planId` + `stepDoneId`）：服务端把该步标 `done` 并起一轮，模型先校验再继续；
   * 2. 再标本地反馈态（`completingStepId`）—— 没发出去（离线 / 正在跑一轮）就不要动卡片状态，
   *    否则按钮会一直禁用，用户没法重试。
   *
   * 卡片文案带上步骤标题：用户气泡里出现"已完成第 3 步「保存订单」"，服务端的 `stepDoneId`
   * 才是权威凭据（`text` 只给人看）。
   */
  function completeStep(plan?: PlanCard, stepId?: string): void {
    const card = plan ?? turn.value.plan
    if (!card) return
    const target = stepId ?? handoffStepState(turn.value)?.id
    if (!target) return
    const step = card.message.steps.find((item) => item.id === target)
    const index = card.message.steps.findIndex((item) => item.id === target)
    const label = index >= 0 ? `第 ${index + 1} 步` : '这一步'
    const text =
      step?.issue != null
        ? `我已经把${label}「${step.title}」改好了，请继续`
        : `我已完成${label}「${step?.title ?? target}」，请继续`
    if (!sendWith(text, { planId: card.message.planId, stepDoneId: target })) return
    turn.value = beginStepCompletionState(turn.value, card.message.planId, target)
  }

  /** 展开「修改计划」输入框 */
  function beginPlanRevision(planId: string): void {
    turn.value = beginPlanRevisionState(turn.value, planId)
  }

  /** 修改意见输入变化 */
  function updatePlanDraft(draft: string): void {
    turn.value = updatePlanDraftState(turn.value, draft)
  }

  /** 收起输入框（丢弃草稿） */
  function cancelPlanRevision(): void {
    turn.value = cancelPlanRevisionState(turn.value)
  }

  /**
   * 提交修改意见。
   *
   * 关键差异（与 `replan` 相比）：这条消息带 `revisePlanId`，表达的是"**改这一份计划**"——
   * 服务端据此标记修订轮，模型用 `revise_plan` 增量合并（未改动的步骤保留 id 与完成状态，
   * 进度不丢、planId 不变）。而旧的「重新规划」只是发一句固定文案去"换一份新计划"。
   */
  function revisePlan(input: string, plan?: PlanCard): void {
    const card = plan ?? turn.value.plan
    const message = input.trim()
    if (!card || !message) return
    // 先发再标"修改中"：没发出去（离线 / 正在跑一轮）时不要动卡片状态，
    // 否则这条提示会一直挂着（服务端的修订结果永远回不来）。
    if (!sendWith(message, { revisePlanId: card.message.planId })) return
    turn.value = submitPlanRevisionState(turn.value, card.message.planId)
  }

  /** 重新生成计划：全量重来（`propose_plan` 路径），旧计划会被标为 superseded */
  function replan(): void {
    // 这句话不带 revisePlanId ⇒ 本轮不是修订轮 ⇒ 模型可以 propose_plan 出新计划。
    // 与「修改计划」的区别必须在文案里说清，否则模型可能只是又改一遍原计划。
    send('这份计划整体不合适，请推翻它、重新生成一版（不要在原计划上改）')
  }

  /** 切换模式并立刻发一轮（用户在 ModeSwitch 上选完模式后说一句） */
  function sendWithMode(mode: AgentMode, input: string): void {
    sendWith(input, { mode })
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
    // 会话 = 连接：重连/新会话意味着服务端的计划、提问与模式都不存在了 —— 本地卡片必须一起清掉，
    // 否则用户会对着"上一辈子"的计划卡点「开始执行」（服务端只会回"计划已更新"）。
    turn.value = createTurnState()
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
  // 回合边界的三块：模式条 / 计划卡 / 问题卡（状态迁移全在 lib/turnState.ts）
  const mode = computed(() => turn.value.mode)
  const plan = computed(() => turn.value.plan)
  const ask = computed(() => turn.value.ask)
  /** 当前等你操作的那一步（计划卡与自写 UI 共用同一口径：只认服务端 `waiting-user`） */
  const handoff = computed<PlanStep | null>(() => handoffStepState(turn.value) ?? null)

  return {
    messages,
    bubbles,
    trace,
    traceSummary,
    loading,
    welcome,
    sessionReady,
    mode,
    plan,
    ask,
    handoff,
    send,
    sendWith,
    confirmPlan,
    completeStep,
    beginPlanRevision,
    updatePlanDraft,
    cancelPlanRevision,
    revisePlan,
    replan,
    sendWithMode,
    cancel,
    reset,
    startNewSession,
    _handleServerMessage: handleServerMessage,
    _handleSessionReset: handleSessionReset,
  }
}
