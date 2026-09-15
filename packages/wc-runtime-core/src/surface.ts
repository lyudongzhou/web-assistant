// 渲染面契约（本次「内核 / 渲染面」解耦的核心）。
//
// 内核（kernel.ts）只负责：当前是哪一页 + 服务 / 状态 / 事件 / 观测 / 留痕 + 页面目录。
// 「页面怎么落到屏幕」由渲染面（PageSurface）决定，只有两种实现：
//   - container 渲染面（surfaceContainer.ts）：动态加载页面 bundle、注册自定义元素、patch 容器（WC 用法）
//   - host 渲染面（surfaceHost.ts）：把视图交给宿主自己的渲染机制（真实 vue-router / tab / 平台视图）
//
// 三条硬约束：
// 1. 内核不得引用容器 / 自定义元素 / bundle / 样式隔离等 WC 概念（只认本文件的接口）。
// 2. 渲染面不得感知 agent / 协议 / WebSocket；它只渲染内核给的 view。
// 3. 历史归属通过可选的 `history` 声明：不给 = 内核自己的 entries；给了 = 宿主真实历史是最终裁决。
import type { NetworkObserver } from './observer.js'
import type { MutableServicesRef } from './services.js'
import type {
  NavigationResult,
  NavigationSource,
  NavigationTarget,
  NormalizedManifest,
  RouterBridge,
  RouterBridgeApi,
  RuntimeNavApi,
  RuntimeRoute,
  RuntimeView,
} from './types.js'

/** render 的上下文：显式表达「是否替换历史」与「谁发起」 */
export interface SurfaceRenderContext {
  replace: boolean
  source: NavigationSource
}

/**
 * 宿主真实历史（host 渲染面提供）。给了就接管内核的可回退判定与前进 / 后退。
 * container 渲染面不提供 —— 内核沿用 NavigationController 自己的 entries。
 */
export interface RuntimeHistory {
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  go(delta: number): void | Promise<void>
}

/**
 * 渲染面：内核与「页面怎么落到屏幕」之间的唯一边界。
 * 生命周期：`attach`（init 时一次）→ `ensure` / `prepare` / `render`（每次导航）→ `dispose`。
 */
export interface PageSurface {
  /**
   * 该渲染面负责的 framework；null = 不限（container 渲染面按 route.framework 分派）。
   * host 渲染面必须给出具体 framework（如 'vue'），内核据此兜底 manifest 里未声明 framework 的页面。
   */
  readonly framework: string | null
  /** init 时调用一次：把已归一化的 manifest 交给渲染面（container: 建容器管理者 + 收共享样式） */
  attach(manifest: NormalizedManifest, root: Element | null): Promise<void>
  /** 设置 / 更新挂载点（host 渲染面实现为空操作） */
  mount(root: Element | null): void
  /** 框架级就绪（container: 容器 + 框架 router 桥）；失败应 throw，内核转成 load-failed */
  ensure(framework: string): Promise<void>
  /** 页面级就绪（container: 加载 bundle + 注册页面；host: 无需准备） */
  prepare(route: RuntimeRoute): Promise<void>
  /** 该页是否已就绪（container: 是否注册过；host: 恒 true） */
  isReady(route: RuntimeRoute): boolean
  /** 落到屏幕；异步失败由内核转成 error 事件 */
  render(view: RuntimeView, ctx: SurfaceRenderContext): void | Promise<void>
  /** 本渲染面提供的样式（container: base→shared→page；host: 恒空） */
  styles(): readonly string[]
  /** 样式集合版本号（append-only、单调递增；host 恒 0） */
  readonly stylesVersion: number
  /**
   * 取页面 `defineExpose` 暴露的对象：
   * - `undefined` = 该渲染面**不支持** expose（内核跳过 page-exposed-changed 广播）
   * - `null` = 支持但没有可读实例（内核广播空 keys）
   */
  getPageExposed?(tag?: string): Record<string, unknown> | null | undefined
  /**
   * 该页在当前渲染面上**此刻**是否可渲染；返回字符串 = 不可渲染的原因。
   *
   * host 模式的典型用途：宿主的页面路由可能是**登录后 / 按权限**才注册的（vben 的 access routes），
   * 未就绪时导航应当得到结构化失败而不是把内核状态推进去（避免「内核以为切了页、宿主 URL 没动」的分裂）。
   * 内核在 commit **之前**调用它（container 渲染面不实现 —— 页面可加载性由 `ensure` / `prepare` 表达）。
   */
  canRender?(route: RuntimeRoute): string | null
  /**
   * 让「页面内发起的导航」汇入内核（container: memory router 桥）。
   * host 渲染面同样可返回桥（出向由 render 完成，所以 apply 为空操作）。
   */
  bindRouter?(framework: string, api: RouterBridgeApi): RouterBridge | null
  /** 宿主当前路由快照（host 模式 init 时用于 adopt 已有页面） */
  snapshot?(): NavigationTarget | null
  /** 宿主真实历史（不给 = 内核自管 entries） */
  readonly history?: RuntimeHistory
  dispose(): void
}

/**
 * 内核交给渲染面的句柄。渲染面拿到的都是「稳定引用」：
 * 路由表用 `routes()` 实时读（setRoutes 后立刻可见），servicesRef / observer 与内核同一份实例。
 */
export interface KernelHandles {
  /** 框架无关导航 API（渲染面 provide 给页面 / 建桥用） */
  readonly navigation: RuntimeNavApi
  readonly servicesRef: MutableServicesRef
  readonly observer: NetworkObserver
  /** 当前路由表（实时） */
  readonly routes: () => readonly RuntimeRoute[]
  /** 页面事件回传（容器接住 CE 事件后调它 → page-event） */
  readonly onPageEvent: (payload: { tag: string; event: string; payload?: unknown }) => void
  /** 重新广播某页的 expose 能力清单（宿主渲染面在页面挂载后可用） */
  readonly broadcastExposed: (tag: string) => void
  /** 只判定不落地（框架 router 的 beforeEach 用） */
  readonly canNavigate: (target: NavigationTarget) => NavigationResult
  /** 落地并渲染（框架 router 的 afterEach 用；不会再回推框架 router，避免回环） */
  readonly commit: (target: NavigationTarget) => Promise<NavigationResult>
}
