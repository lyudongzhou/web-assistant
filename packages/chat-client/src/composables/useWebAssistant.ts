// Headless 装配层：把「socket + runtime 宿主 + 对话状态机」的接线逻辑收在一起。
// 宿主拿到这一堆状态 + 动作，可以完全自定义 UI（样式 / 布局 / 消息渲染），
// 而不需要重复 WebAssistant.vue 里的接线胶水。
//
// 职责边界：
//   - agentSocket.ts  → WS 连接（session / 重连退避 / 心跳 / RPC）
//   - useRuntimeHost  → 渲染宿主（manifest / 容器 / 路由 / 样式）
//   - useAgentChat    → 对话状态机（消息 / loading / 流式拼接 / tool.call 分发）
//   - 本文件          → 把三者接起来，并负责「运行时事件 → socket 转发」的映射
import { onMounted, onUnmounted, ref, watch, type Ref, type ShallowRef } from 'vue'
import { createAgentSocket, type AgentSocket, type AgentSocketState } from '../lib/agentSocket.js'
import { useRuntimeHost } from './useRuntimeHost.js'
import { useAgentChat } from './useAgentChat.js'
import { useWelcomePage } from './useWelcomePage.js'
import type { ServerMessage, WelcomePayload } from '@webassistant/protocol/websocket'
import { withActivityOrigin, type WcActivity } from '@webassistant/wc-runtime-vue/host'
import type {
  NavigationResult,
  NavigationTarget,
  Runtime,
  RuntimeErrorInfo,
  RuntimeRoute,
  RuntimeServices,
  RuntimeStatus,
} from '@webassistant/wc-runtime-vue/host'
import type { ChatMessage, PageChangeInfo, PageEventPayload } from '../types.js'
import type { UseWelcomePageReturn } from './useWelcomePage.js'

export interface UseWebAssistantOptions {
  /** manifest 在 {wcBase}/manifest.json，WC 产物在 {wcBase}/dist-ce（默认 '/wc'） */
  wcBase?: string
  /** WebSocket 地址前缀（默认 '/ws'） */
  wsBase?: string
  /**
   * 首屏是否自动打开页面（默认 `false` → 渲染区展示欢迎页）：
   * `true` = 打开 manifest 第一个页面；字符串 = 打开指定 tag 的页面。
   */
  initialPage?: boolean | string
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
  send: (input: string) => void
  cancel: () => void
  reset: () => void
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
}

export function useWebAssistant(options: UseWebAssistantOptions = {}): UseWebAssistantReturn {
  const wcBase = options.wcBase ?? '/wc'
  const wsBase = options.wsBase ?? '/ws'

  // ---- WebSocket：聊天 + 观察转发 + tool.call 应答，共用一条 WS 连接 ----
  const socket = ref<AgentSocket | null>(null)
  const wsStatus = ref<AgentSocketState>('disconnected')

  // chatHandle 是 ref：useAgentChat 挂上后把 handleServerMessage 写进来，
  // socket.onMessage 回调用它来分发所有 server 消息（chat.text / tool.call / done / error）
  const chatHandle = ref<((msg: ServerMessage) => void) | null>(null)

  onMounted(() => {
    const agentSocket = createAgentSocket({
      wsBase,
      wcBase,
      onMessage: (message) => chatHandle.value?.(message),
      onStateChange: (state) => { wsStatus.value = state },
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
    activities,
    clearActivities,
    navigate,
    back,
    callPageMethod,
    runtime: hostRuntime,
  } = useRuntimeHost({
    wcBase: () => wcBase,
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
    onNetworkObservation: (observation) => {
      // 方案 B：NetworkObserver 默认关闭；如果被开启，仍然转发（向后兼容）
      socket.value?.sendObservation(observation)
    },
    onPageData: (snapshot) => {
      // 方案 B 主通道：页面 apiBus.report() → runtime 摘要 → 这里转发给 agent-server
      socket.value?.sendPageData(snapshot)
    },
    onPageExposed: (info) => {
      // 当前页 expose 能力清单 → ws page.exposed（agent 据此构造 call_page_method）
      socket.value?.sendPageExposed(info)
    },
    onError: (info) => options.onError?.(info),
  })

  // ---- 对话状态机 ----
  const { messages, loading, welcome, sessionReady, send, cancel, reset, _handleServerMessage } = useAgentChat({
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
    loading,
    welcome,
    sessionReady,
    welcomePage,
    send,
    cancel,
    reset,
    mountEl,
    pageTitle,
    hasPage,
    currentTag,
    manifestSettled,
    canGoBack,
    status,
    error,
    routes,
    runtime: hostRuntime,
    activities,
    clearActivities,
    navigate,
    back,
    callPageMethod,
  }
}
