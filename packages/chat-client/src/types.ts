// chat-client 的对外类型。
// 运行时契约（manifest / SSE / page-event）来自 @webassistant/protocol，
// runtime 相关类型来自 @webassistant/wc-runtime-vue/host —— 宿主不需要感知 core。
import type { Component } from 'vue'
import type { PageEventPayload, WelcomeCapability, WelcomePayload } from '@webassistant/protocol'
// 欢迎页（渲染区空态）的类型与逻辑同源：Variant 定义在 lib/welcome.ts（纯逻辑、可单测），这里转出给宿主。
import type { WelcomeVariant } from './lib/welcome.js'
import type {
  NavigationSource,
  Runtime,
  RuntimeErrorInfo,
  RuntimeRoute,
  RuntimeServices,
  RuntimeStatus,
  RuntimeSurfaceKind,
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

/**
 * 宿主构造 runtime 的上下文（`createRuntime` 注入口的入参）。
 * host 模式（`surface: 'host'`）下宿主用 `createVueHostRuntime({ router, app, ... })` 造出 runtime 返回；
 * container 模式（缺省）不需要这个注入口，chat-client 自己按 `wcBase` 拉 manifest + dist-ce。
 */
export interface WebAssistantRuntimeContext {
  /** manifest 基址（`{wcBase}`）；宿主可据此拼自己的 manifestUrl */
  base: string
  /** 首屏目标（`initialPage` 解析结果；host 模式通常为 null —— 靠 adopt 接管宿主当前路由） */
  initial: { tag: string } | null
  /** 渲染面种类（与 props.surface 一致） */
  surface: RuntimeSurfaceKind
}

export interface WebAssistantProps {
  /** manifest 在 {wcBase}/manifest.json，WC 产物在 {wcBase}/dist-ce */
  wcBase?: string
  /**
   * 渲染面（用法）：
   * - `container`（缺省）：WC 用法 —— 页面编译成 Web Component，在面板内的渲染区渲染
   * - `host`：宿主直连用法 —— agent 操作宿主自己的 router，页面在宿主自己的 `<router-view>` 渲染
   *   （必须同时给 `createRuntime`，由宿主提供 `createVueHostRuntime` 造出的 runtime）
   */
  surface?: RuntimeSurfaceKind
  /**
   * runtime 构造注入口（host 模式必填）。chat-client 借此保持框架无关（不 import vue-router）：
   * ```ts
   * :create-runtime="({ initial }) => createVueHostRuntime({ router, app, manifestUrl: '/wc/manifest.json', initial })"
   * ```
   */
  createRuntime?: (context: WebAssistantRuntimeContext) => Runtime
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
  /**
   * runtime 就绪回调（init 之后触发一次）。runtime 是**框架无关 API**，宿主可据此反向推数据：
   * ```ts
   * onRuntimeReady: (rt) => {
   *   rt.setState({ user: { name: '张三' } })                       // 业务状态快照（页面 context.state 跟上）
   *   rt.setServices({ getToken: () => authStore.token })            // 中途补宿主能力
   *   hostPinia.use(createHostStorePusher({ getRuntime: () => rt }).plugin)  // 宿主 store → CE store 桥
   * }
   * ```
   */
  onRuntimeReady?: (runtime: Runtime) => void
  /** 把页面 emit 回传给 agent（POST {agentBase}/event）；MVP 默认关闭，避免打扰 agent */
  forwardPageEvents?: boolean
  /**
   * 在渲染区右侧显示「执行监视」日志面板：WC 活动时间线
   * （方法调用 / 导航 / 事件 / 数据上报 / 网络 / 错误，最新在前）。缺省关闭。
   */
  showActivityLog?: boolean
  /** 调试模式：每条活动打 console.debug，并暴露 globalThis.__waActivities / __waRuntime 供控制台排查 */
  debug?: boolean
  /**
   * 首屏是否自动打开页面。默认 **不打开** → 渲染区展示「欢迎页」（欢迎语 + 能力卡片）。
   * - `true`：自动打开 manifest 的第一个页面
   * - 字符串：自动打开指定 tag 的页面
   */
  initialPage?: boolean | string
  /**
   * 渲染区「欢迎页」覆盖。欢迎页 = runtime 当前没有页面（没有渲染子 WC）时渲染区的默认内容。
   * - 缺省（不传）= 内置 `WelcomePage`：渲染 agent 下发的欢迎语 + 能力卡片
   * - 传组件 = 用宿主组件替换（组件会收到 `text` / `capabilities` / `loading` 三个 prop）
   * - `false` = 关闭欢迎页（退回最小空态）
   *
   * 模板式宿主也可用 `#welcome` 具名插槽（插槽优先于本 prop，可拿到合并后的欢迎页状态）。
   */
  welcome?: WelcomeOverride
}

/**
 * 渲染区「欢迎页」覆盖值。
 *
 * 实现说明：除了 `Component`，这里还显式带上 `object | Function` —— 这是给 Vue 编译器的
 * **运行时 prop 类型推断**兜底。只写 `Component | false` 时编译器推断不出 `Component`，
 * 运行时 prop 类型会退化成 `{ type: Boolean }`，宿主传组件就会触发 prop 类型告警。
 */
export type WelcomeOverride = Component | object | ((...args: never[]) => unknown) | false

/** 内置欢迎页（WelcomePage.vue）的 props —— 宿主自定义覆盖组件时按同名字段接收。 */
export interface WelcomePageProps {
  /** 欢迎语正文（可含换行）；缺省用内置默认问候 */
  text?: string
  /** 能力清单（agent 从 manifest 派生；旧服务端用本地 manifest 路由兜底） */
  capabilities?: WelcomeCapability[]
  /**
   * 欢迎内容是否仍在等数据源（握手载荷 / 本地 manifest 都没就绪）。
   * 注意：不是「对话中」——那是 ChatPanel 的 loading。
   */
  loading?: boolean
}

/**
 * `#welcome` 具名插槽的入参：**合并后**的欢迎页状态，模板宿主不必自己再判空/合并。
 * 同时保留 `welcome`（原始载荷）与 `routes`（本地 manifest 路由）供宿主自由发挥。
 */
export interface WelcomePageSlotProps extends WelcomePageProps {
  /** agent 握手下发的原始欢迎载荷（未合并；null = 未下发 / 未连接 / WELCOME_ENABLED=0） */
  welcome: WelcomePayload | null
  /** 本地 manifest 路由（能力清单兜底依据） */
  routes: readonly RuntimeRoute[]
  /** runtime 当前页 tag；null = 没有渲染子 WC（渲染区空态 → 欢迎页可见） */
  currentTag: string | null
  /** 渲染区当前应呈现的内容类型：`page` / `welcome-loading` / `welcome` */
  variant: WelcomeVariant
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
  /** 错误提示边框色（渲染区错误横幅，默认 #fecaca） */
  '--wa-error-border'?: string
  /** 错误提示背景色（渲染区错误横幅，默认 #fef2f2） */
  '--wa-error-bg'?: string
  /** 错误提示文字色（渲染区错误横幅，默认 #b91c1c） */
  '--wa-error-text'?: string
}

export type { PageEventPayload, Runtime, RuntimeErrorInfo, RuntimeRoute, RuntimeServices, RuntimeStatus }
export type { WelcomeCapability, WelcomePayload }
export type { WelcomeVariant }
