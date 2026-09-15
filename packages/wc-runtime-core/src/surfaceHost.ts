// 宿主渲染面适配：把宿主注入的 HostSurface（框架包实现，如 createVueHostSurface）
// 适配成内核使用的 PageSurface。
//
// 内核不知道 vue-router 的存在，宿主也不知道内核的视图状态机 —— 本文件就是两者的接缝。
import type { KernelHandles, PageSurface } from './surface.js'
import type { HostSurface, NavigationTarget, RouterBridge } from './types.js'

/** 宿主渲染面不参与样式体系（样式归宿主自己，无隔离问题） */
const NO_STYLES: readonly string[] = []

export function createHostPageSurface(host: HostSurface, handles: KernelHandles): PageSurface {
  const framework = host.framework
  // 内核接入钩子：宿主实现借此 provide runtime context / 在页面真正挂载后重新广播 expose
  host.bindRuntime?.({
    servicesRef: handles.servicesRef,
    navigation: handles.navigation,
    observer: handles.observer,
    routes: handles.routes,
    broadcastExposed: handles.broadcastExposed,
  })
  return {
    framework,

    async attach(manifest) {
      // 页面目录与宿主真实路由表的一致性校验（缺失一次性报错，避免静默 404）
      host.validateRoutes?.(manifest.routes)
    },

    mount() {
      // 渲染位置由宿主决定（router-view / tab / 平台视图），内核不提供挂载点
    },

    async ensure(target: string) {
      if (target !== framework) {
        throw new Error(`宿主渲染面只服务 framework=${framework}，无法渲染 ${target} 的页面`)
      }
    },

    async prepare() {
      // 页面已就绪（就是宿主自己的路由组件）
    },

    isReady: () => true,

    async render(view, ctx) {
      await host.apply(view, { replace: ctx.replace, source: ctx.source })
    },

    styles: () => NO_STYLES,
    stylesVersion: 0,

    getPageExposed: (tag) =>
      typeof host.getPageExposed === 'function' ? host.getPageExposed(tag) : undefined,

    canRender: (route) => host.canRender?.(route) ?? null,

    bindRouter(target, api): RouterBridge | null {
      if (target !== framework) return null
      return host.createRouterBridge?.(api) ?? null
    },

    snapshot(): NavigationTarget | null {
      return host.snapshot?.() ?? null
    },

    get history() {
      return host.history
    },

    dispose() {
      host.dispose?.()
    },
  }
}
