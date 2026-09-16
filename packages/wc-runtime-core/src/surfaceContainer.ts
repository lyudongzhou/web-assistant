// 容器渲染面（用法 A / WC）：页面 bundle 动态加载 → 注册自定义元素 → patch 容器。
//
// 本文件是「内核 / 渲染面解耦」中被**原样搬运**的那一段（来自原 runtime.ts 的 ③④⑤ 部分），
// 行为与解耦前逐字节等价：容器懒建与挂载顺序、loading→ready 两帧、样式分层与页级 scope、
// keep/unmount 策略、页面注册与 expose 委托。
// 与内核的唯一接口是 PageSurface（见 surface.ts）。
import { createContainerManager, type ContainerManager } from './containers.js'
import { createBundleLoader, fetchText } from './loader.js'
import { createStyleRegistry, type StyleRegistry } from './styles.js'
import { activateStyleScope, beginStyleScope, clearStyleScopes, endStyleScope } from './styleSink.js'
import type { KernelHandles, PageSurface } from './surface.js'
import type {
  CreateRuntimeOptions,
  NormalizedManifest,
  PageApi,
  PageModule,
  RuntimeRoute,
  RuntimeView,
} from './types.js'

export function createContainerSurface(
  options: CreateRuntimeOptions,
  handles: KernelHandles,
): PageSurface {
  const loader = createBundleLoader(options.importImpl)
  const styles: StyleRegistry = createStyleRegistry()
  let containers: ContainerManager | null = null
  const registeredPages = new Set<string>()

  function requireContainers(): ContainerManager {
    if (!containers) throw new Error('容器渲染面尚未 attach（attach 由 runtime.init 调用）')
    return containers
  }

  /** 加载并注册页面 WC（幂等），同时把页面样式收进 page 层 */
  async function prepare(route: RuntimeRoute): Promise<void> {
    if (registeredPages.has(route.tag)) return
    const entry = await requireContainers().ensure(route.framework)
    // 页面 bundle 首次 import 会执行库的样式注入 —— 这窗口内的改道样式归属本页 scope。
    beginStyleScope(route.tag)
    let mod: PageModule
    try {
      mod = await loader.load<PageModule>(route.bundle)
    } finally {
      endStyleScope()
    }
    const api: PageApi = {
      tag: route.tag,
      route,
      servicesRef: handles.servicesRef,
      navigation: handles.navigation,
      framework: route.framework,
    }
    entry.adapter.definePage(mod ?? {}, api)
    if (mod?.styles?.length) styles.addMany('page', route.tag, mod.styles)
    registeredPages.add(route.tag)
  }

  return {
    /** 不限 framework：按 route.framework 分派到各自容器（多框架批次） */
    framework: null,

    async attach(manifest: NormalizedManifest, root: Element | null): Promise<void> {
      containers = createContainerManager({
        containers: manifest.containers,
        adapters: options.adapters,
        loader,
        servicesRef: handles.servicesRef,
        navigation: handles.navigation,
        strategy: options.containerStrategy,
        onPageEvent: handles.onPageEvent,
      })
      // 挂载点可能稍后才给（宿主容器就绪时调 init(el) / mount(el)）
      if (root) containers.setRoot(root)
      // 跨容器共享样式（框架无关 tokens / 全局 css），失败不阻断启动
      await Promise.all(
        manifest.sharedStyles.map(async (url) => {
          const css = await fetchText(url, options.fetchImpl)
          if (css) styles.add('shared', url, css)
        }),
      )
    },

    mount(root) {
      if (root) containers?.setRoot(root)
    },

    async ensure(framework: string): Promise<void> {
      try {
        await requireContainers().ensure(framework)
      } catch (cause) {
        // 文案保持与解耦前一致（宿主日志 / 单测都依赖它）
        throw new Error(
          `容器加载失败（framework=${framework}）：${(cause as Error)?.message ?? String(cause)}`,
        )
      }
    },

    prepare,
    isReady: (route) => registeredPages.has(route.tag),

    render(view: RuntimeView) {
      if (!containers) return
      if (view.framework) {
        containers.patch(view.framework, view)
        containers.deactivateOthers(view.framework, styles.version)
      }
      // 只让当前页的改道样式挂在容器里（其余页的摘下缓存，切回再挂）
      activateStyleScope(view.tag)
    },

    styles: () => styles.toArray(),
    get stylesVersion() {
      return styles.version
    },

    getPageExposed(tag) {
      if (!containers) return undefined
      const route = tag ? handles.routes().find((item) => item.tag === tag) : undefined
      if (!route) return undefined
      const entry = containers.get(route.framework)
      if (!entry) return undefined
      // 「支持 expose」的判据是 adapter 是否实现该方法；未实现 → undefined（内核跳过广播）
      if (typeof entry.adapter.getPageExposed !== 'function') return undefined
      return entry.adapter.getPageExposed(entry.handle, route.tag) ?? null
    },

    bindRouter(framework, api) {
      const entry = containers?.get(framework)
      if (!entry?.adapter.createRouterBridge) return null
      return entry.adapter.createRouterBridge(api)
    },

    dispose() {
      containers?.dispose()
      containers = null
      registeredPages.clear()
      styles.dispose()
      clearStyleScopes()
    },
  }
}
