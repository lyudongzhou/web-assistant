// chat-client 的对外类型。
// 运行时契约（manifest / SSE / page-event）来自 @webassistant/protocol，
// runtime 相关类型来自 @webassistant/wc-runtime-vue/host —— 宿主不需要感知 core。
import type { PageEventPayload } from '@webassistant/protocol'
import type {
  NavigationSource,
  RuntimeErrorInfo,
  RuntimeRoute,
  RuntimeServices,
  RuntimeStatus,
} from '@webassistant/wc-runtime-vue/host'

/**
 * 「WC 执行监视」的活动记录（由 runtime/容器的 activityBus 产出）。
 * 直接复用 runtime 侧的类型定义，避免两处漂移。
 */
export type { WcActivity, WcActivityKind, WcActivityOrigin } from '@webassistant/wc-runtime-vue/host'

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

/** 页面切换后回调给宿主的信息 */
export interface PageChangeInfo {
  tag: string
  title?: string
  source: NavigationSource
  canGoBack: boolean
  /** 当前路由参数（供 agent-server 同步 session.currentPage.params） */
  params?: Record<string, unknown>
}

export interface WebAssistantProps {
  /** manifest 在 {wcBase}/manifest.json，WC 产物在 {wcBase}/dist-ce */
  wcBase?: string
  /** WebSocket 地址前缀（默认 '/ws'） */
  wsBase?: string
  /** agent-server HTTP 地址前缀（保留，用于 future HTTP 降级） */
  agentBase?: string
  /**
   * 注入业务 WC 的宿主能力。**必须框架无关**（纯函数 / 纯数据 / 订阅回调）：
   * request、t、getToken、theme、state、emit —— 不要传 pinia store / vue-i18n 实例。
   */
  services?: RuntimeServices
  title?: string
  subtitle?: string
  placeholder?: string
  showBackButton?: boolean
  /** 把页面 emit 回传给 agent（POST {agentBase}/event）；MVP 默认关闭，避免打扰 agent */
  forwardPageEvents?: boolean
  /**
   * 在渲染区右侧显示「执行监视」日志面板：WC 活动时间线
   * （方法调用 / 导航 / 事件 / 数据上报 / 网络 / 错误，最新在前）。缺省关闭。
   */
  showActivityLog?: boolean
  /** 调试模式：每条活动打 console.debug，并暴露 globalThis.__waActivities / __waRuntime 供控制台排查 */
  debug?: boolean
}

/**
 * WebAssistant / ChatPanel 用到的 CSS 变量（token）。
 * 宿主在组件挂载点的任意祖先（或 `:root`）上覆盖这些变量即可定制主题，无需改组件源码。
 * 所有变量在组件内都以 `var(--wa-*, 默认值)` 形式消费，未覆盖时保持默认外观。
 */
export interface WebAssistantThemeVars {
  /** 主色：发送按钮 / 用户气泡 / 当前页高亮（默认 #3b82f6） */
  '--wa-primary'?: string
  /** 主色上的对比文字（默认 #fff） */
  '--wa-primary-contrast'?: string
  /** 渲染区背景（默认 #f9fafb） */
  '--wa-bg'?: string
  /** 面板背景（默认 #fff） */
  '--wa-panel-bg'?: string
  /** 边框色（默认 #e5e7eb） */
  '--wa-border'?: string
  /** 深边框色：输入框 / 返回按钮（默认 #d1d5db） */
  '--wa-border-strong'?: string
  /** 浅边框色：面板标题 / 输入栏分隔（默认 #f3f4f6） */
  '--wa-border-light'?: string
  /** 正文色（默认 #1f2937） */
  '--wa-text'?: string
  /** 强文字色：返回按钮（默认 #374151） */
  '--wa-text-strong'?: string
  /** 次要文字色：欢迎语（默认 #6b7280） */
  '--wa-text-secondary'?: string
  /** 弱文字色：提示 / 加载 / 空态（默认 #9ca3af） */
  '--wa-text-muted'?: string
  /** assistant 气泡背景（默认 #f3f4f6） */
  '--wa-assistant-bubble-bg'?: string
  /** 圆角（默认 8px） */
  '--wa-radius'?: string
  /** 大圆角：气泡（默认 12px） */
  '--wa-radius-lg'?: string
  /** 小圆角：返回按钮（默认 6px） */
  '--wa-radius-sm'?: string
  /** 组件根高度（默认 100vh；内嵌时改成 100% 或具体值） */
  '--wa-height'?: string
  /** 执行监视面板宽度（默认 320px） */
  '--wa-log-width'?: string
  /** 执行监视面板背景（默认 #111827） */
  '--wa-log-bg'?: string
  /** 执行监视面板正文色（默认 #d1fae5） */
  '--wa-log-text'?: string
  /** 执行监视面板弱文字色（默认 #9ca3af） */
  '--wa-log-muted'?: string
  /** 执行监视面板边框/分隔色（默认 #374151） */
  '--wa-log-border'?: string
}

export type { PageEventPayload, RuntimeErrorInfo, RuntimeRoute, RuntimeServices, RuntimeStatus }
