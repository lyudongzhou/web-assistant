// runtime 门面（框架无关编排器）：manifest → 容器 → 页面 → 导航 → 渲染。
// core 不直接对外，宿主使用 @webassistant/wc-runtime-vue 的 createVueRuntime。
import { createContainerManager, type ContainerManager } from './containers.js'
import { createEventBus } from './events.js'
import { createBundleLoader, fetchText } from './loader.js'
import { normalizeManifest } from './manifest.js'
import { createNavigationController, type NavigationController } from './navigation.js'
import { createNetworkObserver, type NetworkObserver } from './observer.js'
import { resolveProps } from './props.js'
import { createServicesRef } from './services.js'
import { createStyleRegistry } from './styles.js'
import { apiBus } from './apiBus.js'
import { matchDataSource, summarizeData } from './dataSources.js'
import type {
  CreateRuntimeOptions,
  NavigationResult,
  NavigationTarget,
  NormalizedManifest,
  PageApi,
  PageModule,
  RuntimeAdapter,
  Runtime,
  RuntimeErrorInfo,
  RuntimeEventName,
  RuntimeLocation,
  RuntimeManifestInput,
  RuntimeNavApi,
  RuntimeRoute,
  RuntimeStatus,
  RuntimeView,
} from './types.js'

async function loadManifestJson(
  url: string,
  fetchImpl: typeof fetch | undefined,
): Promise<RuntimeManifestInput> {
  const impl = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  if (!impl) throw new Error('当前环境没有 fetch，请改用 options.manifest 直接传入清单')
  const res = await impl(url)
  if (!res.ok) throw new Error(`manifest 加载失败：${url} (${res.status})`)
  return (await res.json()) as RuntimeManifestInput
}

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  const bus = createEventBus()
  const servicesRef = createServicesRef(options.services ?? {})
  const styles = createStyleRegistry()
  const loader = createBundleLoader(options.importImpl)
  const nav: NavigationController = createNavigationController()
  const registeredPages = new Set<string>()

  // ---- NetworkObserver：拦截 fetch / XHR，广播 observation 事件 ----（默认关闭，避免无差别暴露）
  const observer: NetworkObserver = createNetworkObserver({
    context: () => ({
      page: nav.current?.tag,
      navigationId: nav.navigationId || undefined,
    }),
    // 方案 B：手动上报为主。NetworkObserver 保留能力但默认不自动拦截；
    // 宿主需要时可通过 runtime.setServices 打开（见 observer.start/stop）。
    autoStart: options.observeNetwork === true,
  })
  // observer 事件 → runtime 事件总线，宿主（chat-client）通过 runtime.on('network-observation') 订阅
  observer.on((observation) => bus.emit('network-observation', observation))

  // ---- apiBus：页面手动上报 → 按当前路由的 dataSources 摘要 → page-data 事件 ----
  const detachApiBus = apiBus.attach((report) => {
    const page = nav.current?.tag
    const route = nav.currentRoute
    const dataSources = route?.dataSources
    let data = report.data
    let truncated = false
    let source = report.url
    if (dataSources?.length) {
      const ds = matchDataSource(report.url, dataSources)
      if (ds) {
        source = ds.match
        const summarized = summarizeData(report.data, ds)
        data = summarized.data
        truncated = summarized.truncated
      }
    }
    const snapshot = {
      page,
      source,
      data,
      truncated,
      at: Date.now(),
    }
    bus.emit('page-data', snapshot)
    servicesRef.current.reportApiData?.(snapshot)
  })

  let manifest: NormalizedManifest | null = null
  let containers: ContainerManager | null = null
  let status: RuntimeStatus = 'idle'
  let error: RuntimeErrorInfo | undefined
  let disposed = false
  let ready = false
  let lastCommitAt = 0

  function fail(info: RuntimeErrorInfo): void {
    error = info
    options.onError?.(info)
    bus.emit('error', info)
  }

  function assertActive(): void {
    if (disposed) throw new Error('runtime 已 dispose')
  }

  function currentProps(): Record<string, unknown> {
    const location = nav.current
    const route = nav.currentRoute
    if (!location || !route) return {}
    return resolveProps({ route, params: location.params, props: location.props })
  }

  function buildView(): RuntimeView {
    const route = nav.currentRoute
    return {
      framework: route?.framework ?? null,
      tag: route?.tag ?? null,
      props: currentProps(),
      styles: styles.toArray(),
      stylesVersion: styles.version,
      status,
      error,
      title: route?.title,
      events: route?.events ?? [],
    }
  }

  function render(): RuntimeView {
    const view = buildView()
    if (view.framework && containers) {
      containers.patch(view.framework, view)
      containers.deactivateOthers(view.framework, styles.version)
    }
    bus.emit('view', view)
    return view
  }

  function setStatus(next: RuntimeStatus, keepError = false): void {
    status = next
    if (!keepError && next !== 'error') error = undefined
    bus.emit('status', { status, tag: nav.current?.tag ?? null })
  }

  /**
   * 取当前页（或指定页）的 `defineExpose` 对象。core 不知道各 framework 的 element 结构，
   * 通过 adapter 的可选 getPageExposed 委托。
   * 仅返回函数字段（agent 只能「调用方法」）；非函数字段会被过滤。
   * 返回 null：未渲染 / adapter 不支持 / framework 不存在。
   */
  function getPageExposedRuntime(page?: string): Record<string, unknown> | null {
    if (!containers) return null
    const targetTag = page ?? nav.current?.tag
    if (!targetTag) return null
    const route = nav.routes.find((r) => r.tag === targetTag)
    if (!route) return null
    const entry = containers.get(route.framework)
    if (!entry) return null
    const adapter = entry.adapter as RuntimeAdapter<unknown>
    if (typeof adapter.getPageExposed !== 'function') return null
    const raw = adapter.getPageExposed(entry.handle, targetTag)
    if (!raw || typeof raw !== 'object') return null
    // 只透出函数字段：保证上层（chat-client / agent）拿到的就是可调用方法集合
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'function') out[k] = v
    }
    return out
  }

  /** 视图就绪后调一次：取当前页 expose 的 key 列表，广播 'page-exposed-changed' */
  function broadcastPageExposed(framework: string, tag: string): void {
    const entry = containers?.get(framework)
    if (!entry) return
    const adapter = entry.adapter as RuntimeAdapter<unknown>
    if (typeof adapter.getPageExposed !== 'function') return
    const exposed = adapter.getPageExposed(entry.handle, tag)
    const keys = exposed ? Object.keys(exposed).filter((k) => typeof (exposed as Record<string, unknown>)[k] === 'function') : []
    bus.emit('page-exposed-changed', { tag, keys })
  }

  /** 加载并注册页面 WC（幂等），同时把页面样式收进 page 层 */
  async function ensurePage(route: RuntimeRoute): Promise<void> {
    if (registeredPages.has(route.tag)) return
    const entry = await containers!.ensure(route.framework)
    const mod = await loader.load<PageModule>(route.bundle)
    const api: PageApi = {
      tag: route.tag,
      route,
      servicesRef,
      navigation: navApi,
      framework: route.framework,
      observer,
    }
    entry.adapter.definePage(mod ?? {}, api)
    if (mod?.styles?.length) styles.addMany('page', route.tag, mod.styles)
    registeredPages.add(route.tag)
  }

  const bridges = new Map<string, import('./types.js').RouterBridge>()

  /** 为提供 createRouterBridge 的框架建桥：让页面里的 router.push 驱动 runtime */
  async function ensureBridge(framework: string): Promise<void> {
    if (bridges.has(framework)) return
    const entry = await containers!.ensure(framework)
    if (!entry.adapter.createRouterBridge) return
    const bridge = entry.adapter.createRouterBridge({
      routes: nav.routes,
      canNavigate: (target) => nav.canNavigate({ ...target, source: target.source ?? 'page' }),
      commit: (target) => applyNavigation({ ...target, source: target.source ?? 'page' }, true),
    })
    bridges.set(framework, bridge)
  }

  /** 落地后的渲染流程：先按已加载状态出一帧，未加载则 loading → ready 两帧 */
  async function settle(
    location: RuntimeLocation,
    route: RuntimeRoute,
    fromBridge: boolean,
    replace: boolean,
  ): Promise<NavigationResult> {
    const loaded = registeredPages.has(route.tag)
    lastCommitAt = Date.now()
    setStatus(loaded ? 'ready' : 'loading')
    render()

    if (!loaded) {
      try {
        await ensurePage(route)
        setStatus('ready')
        render()
      } catch (cause) {
        const info: RuntimeErrorInfo = {
          message: `页面 <${route.tag}> 加载失败：${(cause as Error)?.message ?? String(cause)}`,
          tag: route.tag,
          framework: route.framework,
          cause,
        }
        status = 'error'
        error = info
        render()
        fail(info)
      }
    }

    bus.emit('navigate', {
      location,
      route,
      source: location.source,
      canGoBack: nav.canGoBack,
      canGoForward: nav.canGoForward,
    })
    if (!fromBridge) await bridges.get(route.framework)?.apply(location, replace)
    // 视图就绪后广播当前页 expose 能力清单（agent call_page_method 的依据）
    broadcastPageExposed(route.framework, route.tag)
    return { ok: true, location, route, duplicated: false }
  }

  async function applyNavigation(
    target: NavigationTarget,
    fromBridge = false,
  ): Promise<NavigationResult> {
    assertActive()
    if (!containers) {
      return { ok: false, reason: 'aborted', detail: 'runtime 尚未 init' }
    }
    const resolved = nav.resolve(target)
    if (!resolved.ok) {
      fail({ message: `导航失败：${resolved.detail ?? resolved.reason}` })
      return resolved
    }
    try {
      await containers.ensure(resolved.route.framework)
      await ensureBridge(resolved.route.framework)
    } catch (cause) {
      const info: RuntimeErrorInfo = {
        message: `容器加载失败（framework=${resolved.route.framework}）：${
          (cause as Error)?.message ?? String(cause)
        }`,
        framework: resolved.route.framework,
        cause,
      }
      fail(info)
      return { ok: false, reason: 'load-failed', detail: info.message }
    }
    const committed = nav.commit(target)
    if (!committed.ok) {
      if (committed.reason !== 'aborted') {
        fail({ message: `导航失败：${committed.detail ?? committed.reason}` })
      }
      return committed
    }
    return settle(committed.location, committed.route, fromBridge, target.replace === true)
  }

  async function goInternal(delta: number): Promise<NavigationResult> {
    assertActive()
    const result = nav.go(delta)
    if (!result.ok) return result
    return settle(result.location, result.route, false, true)
  }

  const navApi: RuntimeNavApi = {
    push: (target) => applyNavigation({ ...target, source: target.source ?? 'page' }),
    replace: (target) => applyNavigation({ ...target, replace: true, source: target.source ?? 'page' }),
    back: () => goInternal(-1),
    forward: () => goInternal(1),
    go: (delta) => goInternal(delta),
    current: () => nav.current,
    get canGoBack() {
      return nav.canGoBack
    },
    get canGoForward() {
      return nav.canGoForward
    },
  }

  async function init(container: Element): Promise<void> {
    assertActive()
    if (ready) {
      containers?.setRoot(container)
      return
    }
    const raw =
      options.manifest ??
      (options.manifestUrl ? await loadManifestJson(options.manifestUrl, options.fetchImpl) : null)
    if (!raw) throw new Error('createRuntime 需要 manifest 或 manifestUrl')

    manifest = normalizeManifest(raw, {
      assetBase: options.assetBase,
      preRegisteredFrameworks: (options.adapters ?? []).map((adapter) => adapter.framework),
    })
    nav.setRoutes(manifest.routes)
    containers = createContainerManager({
      containers: manifest.containers,
      adapters: options.adapters,
      loader,
      servicesRef,
      navigation: navApi,
      observer,
      strategy: options.containerStrategy,
      onPageEvent: (payload) => bus.emit('page-event', payload),
    })
    containers.setRoot(container)
    ready = true

    // 跨容器共享样式（框架无关 tokens / 全局 css），失败不阻断启动
    await Promise.all(
      manifest.sharedStyles.map(async (url) => {
        const css = await fetchText(url, options.fetchImpl)
        if (css) styles.add('shared', url, css)
      }),
    )

    if (options.preload === 'all') {
      for (const route of manifest.routes) {
        try {
          await ensurePage(route)
        } catch (cause) {
          fail({
            message: `预加载页面 <${route.tag}> 失败：${(cause as Error)?.message ?? String(cause)}`,
            tag: route.tag,
            framework: route.framework,
            cause,
          })
        }
      }
    }

    const first = manifest.routes[0]
    const initial =
      options.initial === null ? null : options.initial ?? (first ? { tag: first.tag } : null)
    if (initial) {
      await applyNavigation({ ...initial, replace: true, source: initial.source ?? 'initial' })
    } else {
      render()
    }
  }

  return {
    init,
    navigate: (target) => applyNavigation({ ...target, source: target.source ?? 'host' }),
    back: () => goInternal(-1),
    forward: () => goInternal(1),
    go: (delta) => goInternal(delta),
    get canGoBack() {
      return nav.canGoBack
    },
    get canGoForward() {
      return nav.canGoForward
    },
    get view() {
      return buildView()
    },
    get current() {
      const location = nav.current
      const route = nav.currentRoute
      return location && route ? { location, route, at: lastCommitAt } : null
    },
    get routes() {
      return nav.routes
    },
    getPageExposed(page) {
      return getPageExposedRuntime(page)
    },
    nav: navApi,
    setServices(patch) {
      assertActive()
      const keys = servicesRef.set(patch)
      if (keys.length) bus.emit('services', { keys })
    },
    setState(patch) {
      assertActive()
      const keys = servicesRef.setState(patch)
      if (keys.length) bus.emit('state', { patch, keys })
    },
    getState() {
      return servicesRef.stateBridge.get()
    },
    async setRoutes(routes) {
      assertActive()
      nav.setRoutes(routes)
      for (const bridge of bridges.values()) bridge.setRoutes(routes)
      if (!nav.current && routes[0]) {
        await applyNavigation({ tag: routes[0].tag, replace: true, source: 'host' })
        return
      }
      render()
      // 已有当前页时，路由变化可能改了暴露面（同名 tag 不同 bundle），重新广播
      const currentRoute = nav.currentRoute
      if (currentRoute) broadcastPageExposed(currentRoute.framework, currentRoute.tag)
    },
    beforeEach: (guard) => nav.beforeEach(guard),
    on: <E extends RuntimeEventName>(event: E, handler: Parameters<typeof bus.on<E>>[1]) =>
      bus.on(event, handler),
    dispose() {
      if (disposed) return
      disposed = true
      detachApiBus()
      for (const bridge of bridges.values()) bridge.dispose()
      bridges.clear()
      containers?.dispose()
      containers = null
      nav.dispose()
      observer.dispose()
      styles.dispose()
      servicesRef.dispose()
      bus.clear()
      registeredPages.clear()
    },
  }
}

