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
 * host 模式（`surface: 'host'`）下宿主用 `createVueHostRuntimeBinding` 造出 `createRuntime` 返回；
 * 或直接 `({ base, initial }) => createVueHostRuntime({ router, app, manifestUrl: base + '/manifest.json', initial })`；
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
   * 渲染面（用法）。**缺省自动推导**（见 `lib/surface.ts`）：
   * - 给了 `createRuntime` ⇒ `host`：宿主直连 —— agent 操作宿主自己的 router，
   *   页面在宿主自己的 `<router-view>` 渲染
   * - 否则 ⇒ `container`：WC 用法 —— 页面编译成 Web Component，在面板内的渲染区渲染
   *
   * 显式传入时以此为准；显式 `host` 必须同时给 `createRuntime`（由宿主提供
   * `createVueHostRuntime` 造出的 runtime）。**不要**为了「保险」两边都传 —
   * 只给 `createRuntime` 而漏 `surface`（或反之）在归一化前会静默错配。
   */
  surface?: RuntimeSurfaceKind
  /**
   * runtime 构造注入口（宿主直连 / host 模式必填；给了它 `surface` 缺省即为 `host`）。
   * chat-client 借此保持框架无关（不 import vue-router）：
   * ```ts
   * :create-runtime="createRuntime"   // 来自 createVueHostRuntimeBinding({ router, app, services })
   * ```
   */
  createRuntime?: (context: WebAssistantRuntimeContext) => Runtime
  /** WebSocket 地址前缀（默认 '/ws'） */
  wsBase?: string
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

/**
 * `<HostAssistantDock>` 的 props —— **宿主直连面（用法 B）开箱即用**的悬浮助手窗。
 *
 * 与 `<WebAssistant>` 的分工：`WebAssistant` 面向**容器面**（面板里有渲染区，页面在这里渲染）；
 * dock 面向**宿主直连面**（页面在宿主自己的 `<router-view>`，面板只承载对话 + 运行状态 + 动作时间线）。
 * 它把接线（`useWebAssistant` + socket + 收起/展开 + 状态行）都做完，宿主只需给它一个 `createRuntime`：
 *
 * ```vue
 * <script setup lang="ts">
 * import { createVueHostRuntimeBinding } from '@webassistant/wc-runtime-vue/host-router'
 * import { HostAssistantDock } from '@webassistant/chat-client'
 *
 * const { createRuntime } = createVueHostRuntimeBinding({ router, app, services })
 * </script>
 * <template>
 *   <RouterView />
 *   <!-- ⚠️ 必须挂在 <router-view> 之外：挂路由组件里的话，agent 一导航面板自己就被卸载 -->
 *   <HostAssistantDock :create-runtime="createRuntime" :services="services" />
 * </template>
 * ```
 *
 * 要更深的定制（换布局 / 只取一部分）就用 headless 的 `useWebAssistant()`，
 * 或直接复用 `HostAssistantChat` + `HostAssistantActivities` 这两个「数据进、事件出」的组件。
 */
export interface HostAssistantDockProps {
  /**
   * ★ 宿主直连 runtime 的注入口（给了它，渲染面缺省即推导为 `host`）：
   * `createVueHostRuntimeBinding({ router, app, services }).createRuntime`
   */
  createRuntime: (context: WebAssistantRuntimeContext) => Runtime
  /** 宿主能力（框架无关；建议与传给 runtime 的是同一份） */
  services?: RuntimeServices
  /** WebSocket 地址前缀（默认 '/ws'） */
  wsBase?: string
  /** 面板标题（缺省 'WebAssistant'） */
  title?: string
  /** 头部徽标文案（缺省 '宿主直连'；传空串可隐藏） */
  badge?: string
  /** 初始是否展开（缺省 `true`） */
  defaultOpen?: boolean
  /** 收起后按钮上的文案（缺省 '打开助手'） */
  openLabel?: string
  /** 输入框占位 */
  placeholder?: string
  /** 空态建议（点一下即发送）；`[]` = 不显示建议区 */
  suggestions?: string[]
  /** 空态标题 / 说明 */
  helloTitle?: string
  helloHint?: string
  /** 状态行（连接 / 导航来源 / runtime / 当前页 expose）缺省显示 */
  showStatusLine?: boolean
  /** 「本轮动作」时间线缺省显示 */
  showActivities?: boolean
  /** 「本轮动作」初始是否展开（缺省收起） */
  activitiesDefaultOpen?: boolean
  /** 回传活动条数上限（缺省 200，见 `UseRuntimeHostOptions.activityLimit`） */
  activityLimit?: number
  /** 停靠在哪个角（缺省 `bottom-right`） */
  placement?: 'bottom-right' | 'bottom-left'
  /** 调试：把 runtime 挂到 `globalThis.__waRuntime`、活动打 console（透传 `useWebAssistant` 的 debug） */
  debug?: boolean
  /**
   * runtime 就绪回调（init 之后一次）。宿主在这里接自己的东西：
   * 宿主 store → 页面 store 的快照桥、自定义控制台句柄等。
   */
  onRuntimeReady?: (runtime: Runtime) => void
}

export type { PageEventPayload, Runtime, RuntimeErrorInfo, RuntimeRoute, RuntimeServices, RuntimeStatus }
export type { NavigationSource, RuntimeSurfaceKind }
export type { WelcomeCapability, WelcomePayload }
export type { WelcomeVariant }
