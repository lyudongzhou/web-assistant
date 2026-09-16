// wc-runtime-core 的契约本体（定义层）。
// core 只做「定义 + 框架无关实现」，唯一对外门面在 @webassistant/wc-runtime-vue。
//
// 依赖二分模型：
// - runtime 自有依赖（vue / vue-router / element-plus…）：与页面同批构建，靠共享 chunk 单实例，core 不参与。
// - 外层传入依赖（request / t / token / state…）：必须框架无关（纯函数 / 纯数据 / 订阅回调），
//   经 ServicesRef 下发给容器，再由容器 provide 给页面。禁止传框架响应式实例（跨副本响应式不互通）。

export type Unsubscribe = () => void

// ---------------------------------------------------------------- 路由 / manifest

// manifest 的线上 schema 由 @webassistant/protocol 定义（analyzer 产出、core 消费、agent-server 读取）
import type { ManifestDataSource, ManifestParam, ManifestProp, RuntimeManifestInput } from '@webassistant/protocol'

export type RouteParamDef = ManifestParam
export type RoutePropDef = ManifestProp
export type { RuntimeManifestInput }

/** 归一化后的页面路由（一个 tag = 一个业务 WC = 一条路由） */
export interface RuntimeRoute {
  /** 自定义元素标签，必须含 '-' */
  tag: string
  /** 路由名（PascalCase，供 router.push({ name }) 使用） */
  name: string
  /** 路由路径，如 /users/:id */
  path: string
  title?: string
  /** 所属框架批次，决定用哪个容器渲染 */
  framework: string
  /** 页面 bundle 的可加载 URL（已拼好 assetBase）；宿主渲染面模式下为空字符串（页面不经 bundle 渲染） */
  bundle: string
  params: RouteParamDef[]
  props: RoutePropDef[]
  events: string[]
  /**
   * 页面**可选**的数据源声明：命中时 runtime 会对显式上报的数据做字段白名单 / 脱敏 / 行数截断。
   * 注意：它是「额外加固」，**不是**隐私边界 —— 隐私边界是「调用方只在调用点报愿意公开的内容」。
   */
  dataSources?: ManifestDataSource[]
  meta: Record<string, unknown>
}

/** 容器描述（每 framework 一个容器 WC） */
export interface ContainerDescriptor {
  framework: string
  tagName: string
  /** 容器 bundle 的可加载 URL（已拼好 assetBase）；使用预注册 adapter 时为 null */
  bundle: string | null
}

export interface NormalizedManifest {
  version: 2
  routes: RuntimeRoute[]
  containers: ContainerDescriptor[]
  /** 跨容器共享样式的 URL 列表（框架无关 tokens / 全局 css） */
  sharedStyles: string[]
}

// ---------------------------------------------------------------- 导航

export type NavigationSource = 'initial' | 'agent' | 'page' | 'host'

/** 导航目标：tag / name / path 三种寻址，agent 用 tag */
export interface NavigationTarget {
  tag?: string
  name?: string
  path?: string
  params?: Record<string, unknown>
  /** 额外下发给业务 WC 的 props（agent 可直传对象） */
  props?: Record<string, unknown>
  query?: Record<string, string | string[]>
  replace?: boolean
  source?: NavigationSource
}

export interface RuntimeLocation {
  tag: string
  name: string
  path: string
  params: Record<string, unknown>
  query: Record<string, string | string[]>
  props: Record<string, unknown>
  source: NavigationSource
}

export interface NavigationRecord {
  route: RuntimeRoute
  location: RuntimeLocation
  at: number
}

/** 导航守卫：返回 false 中止 */
export type NavigationGuard = (to: RuntimeLocation, from: RuntimeLocation | null) => boolean | void

export type NavigationFailureReason =
  | 'not-found'
  | 'aborted'
  | 'empty'
  | 'out-of-range'
  | 'load-failed'

export type NavigationResult =
  | { ok: true; location: RuntimeLocation; route: RuntimeRoute; duplicated: boolean }
  | { ok: false; reason: NavigationFailureReason; detail?: string }

/** 给页面用的框架无关导航 API（react 页面无需引入任何 router） */
export interface RuntimeNavApi {
  push(target: NavigationTarget): Promise<NavigationResult>
  replace(target: NavigationTarget): Promise<NavigationResult>
  back(): Promise<NavigationResult>
  forward(): Promise<NavigationResult>
  go(delta: number): Promise<NavigationResult>
  current(): RuntimeLocation | null
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

// ---------------------------------------------------------------- 视图 / 状态机

export type RuntimeStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface RuntimeErrorInfo {
  message: string
  tag?: string
  framework?: string
  cause?: unknown
}

/** 下发给容器的唯一数据结构（adapter.patchContainer 的入参） */
export interface RuntimeView {
  framework: string | null
  tag: string | null
  props: Record<string, unknown>
  styles: readonly string[]
  /** 样式集合的版本号（append-only，单调递增），容器可据此跳过重排 */
  stylesVersion: number
  status: RuntimeStatus
  error?: RuntimeErrorInfo
  title?: string
  /** 当前页面声明的事件名（容器据此挂监听，转成 page-event 回传宿主） */
  events: readonly string[]
}

// ---------------------------------------------------------------- 外层传入的服务

/**
 * 宿主注入的能力。**必须框架无关**：纯函数 / 纯数据 / 订阅回调。
 * 不要传 pinia store、vue-i18n 实例、ref/reactive —— 宿主与 runtime 是两份框架副本，
 * 响应式依赖收集不互通，页面能读到值但不会随之更新。业务状态请走 state 快照。
 */
export interface RuntimeServices {
  /** 请求实例 / 函数 */
  request?: unknown
  /** i18n 的翻译函数（$tt / $t 的运行时） */
  t?: (key: string, ...args: unknown[]) => string
  getToken?: () => string | undefined
  locale?: string
  onLocaleChange?: (cb: (locale: string) => void) => Unsubscribe
  /** CSS 变量形式的主题（写到容器 :host 上） */
  theme?: Record<string, string>
  /** 页面事件回传宿主（宿主可再转发给 agent） */
  emit?: (event: string, payload?: unknown) => void
  /** 宿主业务状态的纯数据快照（只读消费，变更走 runtime.setState） */
  state?: Record<string, unknown>
  extras?: Record<string, unknown>
  /** 调用方显式 `apiBus.report()` 上报的数据快照回调（宿主可注册做本地留痕；chat-client 转发给 agent-server） */
  reportApiData?: (snapshot: {
    page?: string
    source: string
    data: unknown
    truncated: boolean
    at: number
  }) => void
}

export interface ServicesChange {
  kind: 'services' | 'state'
  keys: string[]
}

/**
 * services 的稳定引用容器。引用本身永不变（可安全 provide 一次），内容可被替换。
 * state 也是稳定引用（浅合并写入同一对象），容器据 subscribe 通知同步到自己的响应式副本。
 */
export interface ServicesRef {
  readonly current: RuntimeServices
  readonly state: Record<string, unknown>
  subscribe(listener: (ref: ServicesRef, change: ServicesChange) => void): Unsubscribe
}

// ---------------------------------------------------------------- adapter（框架实现的契约）

export interface DefineContainerOptions {
  tagName: string
  servicesRef: ServicesRef
  /** 框架无关导航 API，容器需 provide 给页面 */
  navigation: RuntimeNavApi
  /**
   * 页面 emit 的事件回传通道。容器监听自己 shadow root 内冒泡的 CustomEvent
   * （Vue CE 的 emit 默认 composed:false，正好被容器接住），转成 runtime 的 page-event。
   */
  onPageEvent?: (payload: { tag: string; event: string; payload?: unknown }) => void
}

export interface PageApi {
  tag: string
  route: RuntimeRoute
  servicesRef: ServicesRef
  navigation: RuntimeNavApi
  framework: string
}

/** 页面 bundle 的模块形状（由 vite-plugin-wc 生成） */
export interface PageModule {
  styles?: string[]
  definePage?: (api: PageApi) => unknown
  default?: ((api: PageApi) => unknown) | unknown
}

/** 容器 bundle 的模块形状：默认导出一个 adapter */
export interface ContainerModule<H = unknown> {
  default?: RuntimeAdapter<H>
  adapter?: RuntimeAdapter<H>
}

export interface RouterBridgeApi {
  routes: readonly RuntimeRoute[]
  /** 供框架 router 的 beforeEach 调用：只判定不落地 */
  canNavigate(target: NavigationTarget): NavigationResult
  /** 供框架 router 的 afterEach 调用：落地到 core（不会再回推框架 router，避免回环） */
  commit(target: NavigationTarget): Promise<NavigationResult>
}

/** 框架原生 router 的桥（如 vue-router），让页面 router.push 驱动 runtime */
export interface RouterBridge {
  /** core 侧导航后把结果推给框架 router；实现方需自带防回环（applying 计数器） */
  apply(location: RuntimeLocation, replace: boolean): void | Promise<void>
  setRoutes(routes: readonly RuntimeRoute[]): void
  dispose(): void
}

// ---------------------------------------------------------------- 渲染面（用法 B：宿主直连）

/**
 * 渲染面种类：
 * - `container`（缺省）：页面 bundle 编译成 Web Component，由 runtime 的容器渲染（用法 A）
 * - `host`：导航落到宿主自己的渲染机制（真实 vue-router 等），页面在宿主自己的位置渲染（用法 B）
 */
export type RuntimeSurfaceKind = 'container' | 'host'

/**
 * 内核接入钩子（宿主渲染面实现可用）：
 * 拿内核的稳定引用去 provide runtime context，并在「页面真正挂载后」请求重新广播 expose。
 */
export interface HostSurfaceRuntimeApi {
  /** 外层传入依赖的稳定引用（provide 给宿主页面） */
  readonly servicesRef: ServicesRef
  /** 框架无关导航 API */
  readonly navigation: RuntimeNavApi
  /** 当前页面目录（实时）—— 宿主可用它判断「当前路由是否在目录内」 */
  readonly routes: () => readonly RuntimeRoute[]
  /**
   * 请求内核重新广播某页的 expose 能力清单。
   * host 模式的真实组件可能在本轮导航之后才挂载（异步组件 + RouterView 渲染时机），
   * 宿主实现可在挂载后调它，避免 agent 首轮拿到空的能力清单。
   */
  broadcastExposed(tag: string): void
}

/**
 * 宿主原生渲染面（**框架无关契约**，实现放在框架包里，如 `@webassistant/wc-runtime-vue` 的
 * `createVueHostSurface`）。
 *
 * 语义边界：
 * - runtime 的 `navigate({ tag })` 最终会变成 `apply(view, { replace, source })`；
 * - 宿主自己的导航（点击链接 / 浏览器前进后退）必须经 `createRouterBridge` 的 `afterEach` → `commit` 回流；
 * - 宿主真实 history 是「可回退」的最终裁决（给 `history` 即接管内核自己的 entries）。
 */
export interface HostSurface {
  /** 归属框架，必须与页面 `framework` 对齐（Vue 宿主 = 'vue'） */
  framework: string
  /**
   * 把「当前页」落到宿主渲染面（真实 `router.replace/push({ name, params, query })` / tab 切换…）。
   * 抛错表示宿主拒绝了这次导航（内核广播 error + 调用方拿到结构化失败）。
   */
  apply(view: RuntimeView, options: { replace: boolean; source: NavigationSource }): void | Promise<void>
  /** 内核接入钩子（init 时调用一次） */
  bindRuntime?(api: HostSurfaceRuntimeApi): void
  /**
   * 页面目录一致性校验（init 时调用一次）：
   * 宿主应把「manifest 声明但真实路由表里没有」的页面**一次性报出来**。
   *
   * 注意：**不要**用抛错实现 —— 真实项目的页面路由常常是登录后 / 按权限才注册的
   * （vben 的 access routes 就是这样），init 时它们可能还不存在。宿主实现应记录并告警，
   * 由 `canRender` 在实际导航时给出结构化失败。
   */
  validateRoutes?(routes: readonly RuntimeRoute[]): void
  /**
   * 该页此刻是否可渲染（内核在 commit 前调用）；返回原因字符串 = 不可渲染。
   * 典型实现：`router.hasRoute(route.name) ? null : '宿主 router 未注册该路由…'`
   */
  canRender?(route: RuntimeRoute): string | null
  /** 取页面 defineExpose（agent call_page_method 的入口）；未实现 = 该宿主不支持 expose */
  getPageExposed?(page?: string): Record<string, unknown> | null
  /** 宿主真实历史；给了就接管内核的可回退判定与前进 / 后退（host 模式应当给） */
  history?: {
    readonly canGoBack: boolean
    readonly canGoForward: boolean
    go(delta: number): void | Promise<void>
  }
  /** 宿主当前路由快照（host 模式 init 时用于 adopt 已有页面）；无当前页返回 null */
  snapshot?(): NavigationTarget | null
  /** 让宿主 router 的导航回流内核（beforeEach 守卫前移 + afterEach commit） */
  createRouterBridge?(api: RouterBridgeApi): RouterBridge
  dispose?(): void
}

export interface RuntimeAdapter<H = unknown> {
  readonly framework: string
  /** 默认容器标签名（manifest 未声明时用） */
  readonly defaultTagName?: string
  defineContainer(options: DefineContainerOptions): H
  mountContainer(handle: H, root: Element): void
  patchContainer(handle: H, view: RuntimeView): void
  unmountContainer(handle: H): void
  /** 把页面模块注册成自定义元素（幂等） */
  definePage(module: PageModule, api: PageApi): void
  createRouterBridge?(api: RouterBridgeApi): RouterBridge
  /**
   * 透出页面 `defineExpose` 暴露的能力（agent call_page_method 的执行入口）。
   * - tag 不传：取该容器当前页
   * - tag 传了：取该容器已渲染的指定 tag（容器需自行维护 tag → element 映射）
   * - 未实现该方法的 adapter：返回 null，core 视为「该 framework 不支持 expose 调用」
   */
  getPageExposed?(handle: H, tag?: string): Record<string, unknown> | null
  dispose?(): void
}

// ---------------------------------------------------------------- 事件

export interface RuntimeEventMap {
  view: RuntimeView
  navigate: {
    location: RuntimeLocation
    route: RuntimeRoute
    source: NavigationSource
    canGoBack: boolean
    canGoForward: boolean
  }
  status: { status: RuntimeStatus; tag: string | null }
  'page-event': { tag: string; event: string; payload?: unknown }
  /** 调用方显式 `apiBus.report()` 上报的数据快照（宿主可转成 ws 的 page.data） */
  'page-data': {
    page?: string
    source: string
    data: unknown
    truncated: boolean
    at: number
  }
  /**
   * 页面 `defineExpose` 能力清单变化（agent 透传给 server 用）。
   * 仅含 key 列表（无函数体）；按 tag 分组，宿主按需缓存。
   */
  'page-exposed-changed': { tag: string; keys: string[] }
  state: { patch: Record<string, unknown>; keys: string[] }
  services: { keys: string[] }
  error: RuntimeErrorInfo
}

export type RuntimeEventName = keyof RuntimeEventMap

// ---------------------------------------------------------------- 门面

export type ContainerStrategy = 'keep' | 'unmount'

export interface CreateRuntimeOptions {
  /** 直接给 manifest 对象，或用 manifestUrl 拉取 */
  manifest?: RuntimeManifestInput
  manifestUrl?: string
  /** 产物根地址，用于拼 bundle / sharedStyles 的相对路径 */
  assetBase?: string
  /** 预注册 adapter（runtime-vue 会传自己；此时该 framework 无需容器 bundle） */
  adapters?: RuntimeAdapter[]
  /**
   * 渲染面种类（缺省 `container`）：
   * - `container`：WC 用法（页面 bundle + 容器渲染）
   * - `host`：宿主直连用法（必须同时给 `hostSurface`）
   */
  surface?: RuntimeSurfaceKind
  /** 宿主渲染面实现（`surface: 'host'` 时必填） */
  hostSurface?: HostSurface
  /**
   * host 模式：init 时是否把宿主**当前路由**纳入内核（缺省 true）。
   * 打开后 agent 首轮决策就知道「用户现在在哪个页面」；关闭则从空态开始。
   */
  adopt?: boolean
  services?: RuntimeServices
  containerStrategy?: ContainerStrategy
  /** 初始导航目标，缺省为第一条路由 */
  initial?: NavigationTarget | null
  /** 初始化时是否预加载全部页面 bundle（换页无 FOUC，代价是首屏更慢；host 模式无意义） */
  preload?: 'none' | 'all'
  fetchImpl?: typeof fetch
  importImpl?: (url: string) => Promise<unknown>
  onError?: (error: RuntimeErrorInfo) => void
}

export interface Runtime {
  /**
   * 初始化。`container` 模式需要挂载点；`host` 模式可省（页面由宿主自己渲染）。
   */
  init(container?: Element | null): Promise<void>
  navigate(target: NavigationTarget): Promise<NavigationResult>
  back(): Promise<NavigationResult>
  forward(): Promise<NavigationResult>
  go(delta: number): Promise<NavigationResult>
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /**
   * 是否已有当前页面（渲染区是否已渲染出子 WC）。
   * `false` 等价于「runtime 没有渲染任何子 WC」→ 宿主应展示渲染区空态（欢迎页）。
   * 注意区分「导航过」与「有页面」：页面加载失败时仍是 `true`（有当前页，只是状态为 error）。
   */
  readonly hasPage: boolean
  readonly view: RuntimeView
  readonly current: NavigationRecord | null
  readonly routes: readonly RuntimeRoute[]
  readonly nav: RuntimeNavApi
  setServices(patch: Partial<RuntimeServices>): void
  setState(patch: Record<string, unknown>): void
  getState(): Record<string, unknown>
  setRoutes(routes: RuntimeRoute[]): Promise<void>
  /**
   * 取页面 `defineExpose` 暴露的对象（agent call_page_method 的入口）。
   * - page 不传：当前页
   * - page 传了：已渲染过的指定 tag
   * - 未渲染或 adapter 不支持 expose：返回 null
   */
  getPageExposed(page?: string): Record<string, unknown> | null
  beforeEach(guard: NavigationGuard): Unsubscribe
  on<E extends RuntimeEventName>(
    event: E,
    handler: (payload: RuntimeEventMap[E]) => void,
  ): Unsubscribe
  dispose(): void
}
