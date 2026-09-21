// Headless 装配层：把「socket + runtime 宿主 + 对话状态机」的接线逻辑收在一起。
// 宿主拿到这一堆状态 + 动作，可以完全自定义 UI（样式 / 布局 / 消息渲染），
// 而不需要重复 WebAssistant.vue 里的接线胶水。
//
// 职责边界：
//   - agentSocket.ts  → WS 连接（session / 重连退避 / 心跳 / RPC）
//   - useRuntimeHost  → 渲染宿主（manifest / 容器 / 路由 / 样式）
//   - useAgentChat    → 对话状态机（消息 / loading / 流式拼接 / tool.call 分发）
//   - 本文件          → 把三者接起来，并负责「运行时事件 → socket 转发」的映射
import { onMounted, onUnmounted, ref, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import { createAgentSocket, type AgentSocket, type AgentSocketState, type ChatSendOptions } from '../lib/agentSocket.js'
import { useRuntimeHost } from './useRuntimeHost.js'
import { useAgentChat } from './useAgentChat.js'
import { useWelcomePage } from './useWelcomePage.js'
import type { ServerMessage, WelcomePayload, ChatModeMessage } from '@webassistant/protocol/websocket'
import type { AgentMode, PlanStep } from '@webassistant/protocol'
import type { AskCard, PlanCard } from '../lib/turnState.js'
import { withActivityOrigin, type WcActivity } from '@webassistant/wc-runtime-vue/host'
import type {
  NavigationResult,
  NavigationSource,
  NavigationTarget,
  Runtime,
  RuntimeErrorInfo,
  RuntimeRoute,
  RuntimeServices,
  RuntimeStatus,
  RuntimeSurfaceKind,
} from '@webassistant/wc-runtime-vue/host'
import type { ChatMessage, PageChangeInfo, PageEventPayload, WebAssistantRuntimeContext } from '../types.js'
import type { UseWelcomePageReturn } from './useWelcomePage.js'
import type { TraceSummary } from '../lib/chatTrace.js'
import { resolveSurfaceKind } from '../lib/surface.js'

export interface UseWebAssistantOptions {
  /** manifest 在 {wcBase}/manifest.json，WC 产物在 {wcBase}/dist-ce（默认 '/wc'） */
  wcBase?: string
  /** WebSocket 地址前缀（默认 '/ws'） */
  wsBase?: string
  /**
   * 首屏是否自动打开页面（默认 `false` → 渲染区展示欢迎页）：
   * `true` = 打开 manifest 第一个页面；字符串 = 打开指定 tag 的页面。
   *
   * 与渲染面的关系：`host` 模式下**缺省同样不自动打开**（页面由宿主 URL 决定，靠 `adopt` 纳入内核）；
   * 但显式的 `true` / tag 在 host 模式**依然生效**（会替宿主 router 打开该页）——
   * 想让「页面完全由宿主 URL 决定」，就别传它。
   */
  initialPage?: boolean | string
  /**
   * 渲染面（用法）。**缺省自动推导**（见 lib/surface.ts）：
   * - 给了 `createRuntime` ⇒ `host`（宿主直连：runtime 由宿主注入，页面在宿主自己的 `<router-view>` 渲染）
   * - 否则 ⇒ `container`（WC 用法：页面编译成 Web Component，在面板渲染区显示）
   *
   * 显式传入时以此为准；显式 `host` 必须同时给 `createRuntime`（否则初始化时抛错）。
   */
  surface?: RuntimeSurfaceKind
  /**
   * runtime 构造注入口（宿主直连 / host 模式必填；给了它 `surface` 缺省即为 `host`）。
   * 例：`createVueHostRuntimeBinding({ router, app, services })` 的 `createRuntime`
   * （或直接给 `({ base, initial }) => createVueHostRuntime({ router, app, manifestUrl: base + '/manifest.json', initial })`）
   */
  createRuntime?: (context: WebAssistantRuntimeContext) => Runtime
  /** 注入业务 WC 的宿主能力（框架无关：request / t / getToken / theme / state / emit） */
  services?: RuntimeServices
  /** 页面切换回调（原 WebAssistant 的 'page-change' emit） */
  onPageChange?: (info: PageChangeInfo) => void
  /** 页面事件回调（原 WebAssistant 的 'page-event' emit） */
  onPageEvent?: (payload: PageEventPayload) => void
  /** 错误回调（原 WebAssistant 的 'error' emit） */
  onError?: (error: RuntimeErrorInfo) => void
  /**
   * runtime 就绪回调（init 之后触发一次；runtime 是框架无关 API：setState / setServices / getPageExposed）。
   * 「宿主 pinia → CE store」的快照桥推手需要它：`createHostStorePusher({ getRuntime: () => runtime })`。
   */
  onRuntimeReady?: (runtime: Runtime) => void
  /**
   * 「WC 执行监视」回调：WC 侧发生的活动逐条回调
   * （方法调用 / 导航 / emit / 数据上报 / 网络 / 错误）。与 `activities` 是同一份数据。
   */
  onActivity?: (activity: WcActivity) => void
  /** 本地活动缓冲上限（缺省 200） */
  activityLimit?: number
  /** 调试模式：每条活动打 console，并把 `globalThis.__waActivities` 指到时间线，便于控制台排查 */
  debug?: boolean
}

export interface UseWebAssistantReturn {
  wsStatus: Ref<AgentSocketState>
  messages: Ref<ChatMessage[]>
  loading: Ref<boolean>
  /**
   * 连接握手时 agent 下发的欢迎载荷（渲染区欢迎页用）。
   * headless 宿主可直接拿它渲染自己的欢迎页；未下发（旧服务端）时为 null。
   */
  welcome: Ref<WelcomePayload | null>
  /** 是否已收到 `session.ready`（欢迎页据此退出加载态；未就绪显示「加载中」而不是空态提示） */
  sessionReady: Ref<boolean>
  /**
   * 欢迎页状态机：**渲染区空态**（runtime 没有渲染子 WC）时该显示什么。
   * `variant` / `visible` / `text` / `capabilities` / `loading` —— headless 宿主可直接用它
   * 配导出的 `WelcomePage`（或自己的组件）渲染，不必自己判空与合并兜底。
   */
  welcomePage: UseWelcomePageReturn
  /**
   * 本轮模式判定（`chat.mode`）：`{ requested, effective, decidedBy, reason }`。
   * 宿主/内置 UI 用它显示「当前模式 · 判定来源」。
   */
  mode: ComputedRef<ChatModeMessage | null>
  /** 当前计划卡（`chat.plan`）：proposed = 等确认，approved = 执行中 */
  plan: ComputedRef<PlanCard | null>
  /** 当前等你操作的那一步（计划里 `waiting-user`；没有则 null） */
  handoff: ComputedRef<PlanStep | null>
  /** 当前问题卡（`chat.ask`）：`answer` 非空表示已回答 */
  ask: ComputedRef<AskCard | null>
  send: (input: string) => void
  /** 带附加指令发送（模式 / 确认计划 / 人工步骤完成 / 回答提问） */
  sendWith: (input: string, options?: ChatSendOptions) => void
  /** 确认计划（计划卡「开始执行」） */
  confirmPlan: (plan?: PlanCard) => void
  /** 人工步骤完成回执（计划卡「我已完成，下一步」，chat.send 带 planId + stepDoneId） */
  completeStep: (plan?: PlanCard, stepId?: string) => void
  /** 展开「修改计划」输入框 */
  beginPlanRevision: (planId: string) => void
  /** 修改意见输入变化 */
  updatePlanDraft: (draft: string) => void
  /** 取消修改 */
  cancelPlanRevision: () => void
  /** 提交修改意见（计划卡「提交修改」，chat.send 带 revisePlanId） */
  revisePlan: (input: string, plan?: PlanCard) => void
  /** 重新生成计划（推倒重来） */
  replan: () => void
  /** 以指定模式发一轮（ModeSwitch 用） */
  sendWithMode: (mode: AgentMode, input: string) => void
  cancel: () => void
  reset: () => void
  /** 开始新会话（会话 = 连接）：清空消息 + 重连（服务端新建会话）。UI 的「新会话」入口用它。 */
  startNewSession: () => void
  /** 挂在渲染区域的 div 上 */
  mountEl: Ref<HTMLElement | null>
  pageTitle: Ref<string>
  hasPage: Ref<boolean>
  /** runtime 当前页 tag；null = 没有渲染子 WC（= `hasPage === false`，渲染区显示欢迎页） */
  currentTag: Ref<string | null>
  /** 本地 manifest 是否已 settle（加载成功或失败都算）——欢迎页据此退出加载态 */
  manifestSettled: Ref<boolean>
  canGoBack: Ref<boolean>
  status: Ref<RuntimeStatus>
  error: Ref<RuntimeErrorInfo | null>
  routes: Ref<readonly RuntimeRoute[]>
  /**
   * **实际生效**的渲染面（推导结果，见 lib/surface.ts）。
   * 宿主 UI 据此决定要不要渲染面板内的「渲染区域」——不要再自己判 `props.surface`：
   * 两处各判一次会漂移出静默错配（runtime 是 host、面板却渲染一整列空的渲染区）。
   */
  surface: RuntimeSurfaceKind
  /**
   * 当前页 `defineExpose` 暴露的方法 key 列表（来自 runtime 的 page-exposed-changed 广播）。
   * 自写 UI 的宿主直接用它展示「agent 可调用的方法」，不必自己订阅 runtime。
   */
  pageExposedKeys: Ref<string[]>
  /**
   * 最近一次导航的来源（`agent` / `host` / `page` / `initial`）；`null` = 还没发生过导航。
   * 状态行展示「谁在驱动这个页面」用它，不必自己订阅 runtime。
   */
  navigationSource: Ref<NavigationSource | null>
  /** 宿主侧 runtime 句柄（init 后可用、卸载后回 null）—— 反向推数据/换服务/取页面 expose 用 */
  runtime: ShallowRef<Runtime | null>
  navigate: (target: NavigationTarget) => Promise<NavigationResult | undefined>
  back: () => void
  callPageMethod: <T = unknown>(name: string, args?: unknown[], page?: string) => Promise<
    { ok: true; value: T; async: boolean } | { ok: false; error: string }
  >
  /**
   * WC 活动时间线（**最新在前**）：`kind:'call'` 是「真正执行了什么」
   * （方法名 / 入参 / 耗时 / 返回值 / 错误 / origin=agent|host），其余是 navigate / emit / data / exposed / network / error。
   */
  activities: Ref<WcActivity[]>
  /** 清空活动时间线（同时清 activityBus 的全局缓冲） */
  clearActivities: () => void
  /**
   * **结果气泡**（`kind` 缺省或 `'message'`）—— 对话区只渲染这些。
   * 与 `trace` 互补：两者合起来正好是 `messages`（切分规则见 lib/chatTrace.ts）。
   */
  bubbles: ComputedRef<ChatMessage[]>
  /** **过程条目**（步骤 / 思考 / 错误）—— 渲染进「过程区」，与结果气泡分离 */
  trace: ComputedRef<ChatMessage[]>
  /** 过程区折叠标题的摘要：步数 / 进行中 / 失败 / 本轮耗时 */
  traceSummary: ComputedRef<TraceSummary>
}

export function useWebAssistant(options: UseWebAssistantOptions = {}): UseWebAssistantReturn {
  const wcBase = options.wcBase ?? '/wc'
  const wsBase = options.wsBase ?? '/ws'

  // 渲染面只推导一次（lib/surface.ts）：给了 `createRuntime` ⇒ host。
  // 显式 host 却没给 createRuntime 属于**用错**，这里直接报清楚 ——
  // 否则会一路走到 init 才抛「渲染容器未就绪」（原因是 host 面不渲染面板内挂载点），与真实原因对不上。
  const surface = resolveSurfaceKind(options.surface, options.createRuntime)
  if (surface === 'host' && !options.createRuntime) {
    throw new Error(
      "[useWebAssistant] surface: 'host'（宿主直连）必须同时提供 createRuntime —— " +
        'host 模式的 runtime 由宿主用 createVueHostRuntime(...) 造好后注入。',
    )
  }

  // ---- WebSocket：聊天 + 观察转发 + tool.call 应答，共用一条 WS 连接 ----
  const socket = ref<AgentSocket | null>(null)
  const wsStatus = ref<AgentSocketState>('disconnected')

  // chatHandle / sessionResetHandle 是 ref：useAgentChat 挂上后把处理函数写进来，
  // socket 的回调统一转发到这里（消息分发 + 「重连 = 新会话」的 UI 重置）。
  const chatHandle = ref<((msg: ServerMessage) => void) | null>(null)
  const sessionResetHandle = ref<(() => void) | null>(null)

  onMounted(() => {
    const agentSocket = createAgentSocket({
      wsBase,
      wcBase,
      onMessage: (message) => chatHandle.value?.(message),
      onStateChange: (state) => { wsStatus.value = state },
      // 会话 = 连接：重连/新连接都是新会话 → 清空聊天区并提示
      onSessionReset: () => sessionResetHandle.value?.(),
    })
    socket.value = agentSocket
    agentSocket.connect()
      .catch((cause) => console.warn('[agentSocket] 连接失败', cause))
  })

  onUnmounted(() => {
    socket.value?.disconnect()
    socket.value = null
  })

  // ---- 渲染宿主：manifest / 容器懒建 / 页面 bundle / 路由 / 样式 ----
  const {
    mountEl,
    title: pageTitle,
    hasPage,
    currentTag,
    manifestSettled,
    canGoBack,
    status,
    error,
    routes,
    navigationSource,
    currentPageExposedKeys,
    activities,
    clearActivities,
    navigate,
    back,
    callPageMethod,
    runtime: hostRuntime,
  } = useRuntimeHost({
    wcBase: () => wcBase,
    surface,
    createRuntime: options.createRuntime,
    initialPage: options.initialPage,
    services: options.services,
    activityLimit: options.activityLimit,
    debug: options.debug,
    onActivity: (activity) => {
      if (options.debug) console.debug('[wc-activity]', activity)
      options.onActivity?.(activity)
    },
    onPageChange: (info) => {
      options.onPageChange?.(info)
      // 始终同步当前页面给 agent-server —— agent 决策需要知道当前在哪个页面。
      // NavigationSource 映射：runtime 的 'initial' → 协议的 'host'。
      socket.value?.sendPageNavigated({
        tag: info.tag,
        params: info.params ?? {},
        source: info.source === 'initial' ? 'host' : info.source,
        title: info.title,
      })
    },
    onPageEvent: (payload) => {
      options.onPageEvent?.(payload)
      // 页面 defineEmits → ws page.emit（通知面第二条腿）
      socket.value?.sendPageEmit({
        tag: payload.tag,
        event: payload.event,
        payload: payload.payload,
      })
    },
    onPageData: (snapshot) => {
      // 宿主 / 页面显式 apiBus.report() → runtime 补元信息 → 这里转发给 agent-server
      socket.value?.sendPageData(snapshot)
    },
    onPageExposed: (info) => {
      // 当前页 expose 能力清单 → ws page.exposed（agent 据此构造 call_page_method）
      socket.value?.sendPageExposed(info)
    },
    onError: (info) => options.onError?.(info),
  })

  // ---- 对话状态机 ----
  const {
    messages,
    bubbles,
    trace,
    traceSummary,
    loading,
    welcome,
    sessionReady,
    mode,
    plan,
    handoff,
    ask,
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
    _handleServerMessage,
    _handleSessionReset,
  } = useAgentChat({
    socket: () => socket.value,
    onRender: async ({ tag, params, props: directProps }) => {
      const result = await navigate({
        tag,
        params: params ?? directProps,
        props: directProps,
        source: 'agent',
        replace: true,
      })
      if (result && !result.ok) {
        console.warn(`[render] 导航 ${tag} 失败：${result.detail || result.reason}`)
        options.onError?.({ message: `render ${tag} 失败：${result.detail || result.reason}`, cause: result })
      }
    },
    onCallPageMethod: async ({ name, args, page }) =>
      // 标 origin=agent：容器包裹层记账时会带上，便于区分「agent 调的」与「宿主/页面自己调的」
      withActivityOrigin('agent', () => callPageMethod(name, args, page)),
  })

  chatHandle.value = _handleServerMessage
  sessionResetHandle.value = _handleSessionReset

  // runtime 就绪回调：宿主据此拿到框架无关句柄（setState / setServices / getPageExposed），
  // 「宿主 store → CE store」的推手也挂在这里。
  if (options.onRuntimeReady) {
    const notify = watch(hostRuntime, (rt) => {
      if (rt) options.onRuntimeReady?.(rt)
    }, { immediate: true })
    onUnmounted(notify)
  }

  // ---- 欢迎页 = 渲染区空态（没有渲染子 WC）----
  // 判定/合并逻辑收敛在 useWelcomePage（纯逻辑在 lib/welcome.ts），内置 WelcomePage 与 headless 宿主共用同一份，
  // 避免宿主各自抄一遍「什么时候显示 + 文案从哪来 + 能力清单怎么合并」。
  const welcomePage = useWelcomePage({ welcome, routes, currentTag, sessionReady, manifestSettled })

  // debug 模式：暴露 globalThis.__waActivities 给控制台（只读 getter，随组件卸载移除）
  if (options.debug) {
    Object.defineProperty(globalThis, '__waActivities', {
      configurable: true,
      get: () => activities.value,
    })
    onUnmounted(() => {
      Reflect.deleteProperty(globalThis, '__waActivities')
    })
  }

  return {
    wsStatus,
    messages,
    bubbles,
    trace,
    traceSummary,
    loading,
    welcome,
    sessionReady,
    welcomePage,
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
    mode,
    plan,
    handoff,
    ask,
    cancel,
    reset,
    startNewSession,
    mountEl,
    pageTitle,
    hasPage,
    currentTag,
    manifestSettled,
    canGoBack,
    status,
    error,
    routes,
    surface,
    pageExposedKeys: currentPageExposedKeys,
    navigationSource,
    runtime: hostRuntime,
    activities,
    clearActivities,
    navigate,
    back,
    callPageMethod,
  }
}
