// runtime 内核：与「渲染面」无关的编排。
//
// 内核只做四件事：
//   1. 导航真相源（NavigationController）：agent / 页面 / 宿主 / 页面内 router 的导航最终都汇入它
//   2. 框架无关的服务与状态（services / state）+ 事件总线 + 网络观测 + 操作留痕
//   3. 页面目录（manifest 归一化）与视图状态机（idle / loading / ready / error）
//   4. 把「当前页」编译成 RuntimeView 交给渲染面（PageSurface），并广播 expose 能力清单
//
// 「页面怎么落到屏幕」由渲染面决定（见 surface.ts）：
//   - container 渲染面：bundle + 容器（WC 用法，现状）
//   - host 渲染面：宿主真实 router（宿主直连用法）
// 因此本文件**不得**出现容器 / 自定义元素 / bundle / 样式隔离等 WC 概念。
import { createEventBus, type EventBus } from './events.js'
import { normalizeManifest } from './manifest.js'
import { createNavigationController, type NavigationController } from './navigation.js'
import { createNetworkObserver } from './observer.js'
import { resolveProps } from './props.js'
import { createServicesRef, type MutableServicesRef } from './services.js'
import { apiBus } from './apiBus.js'
import { matchDataSource, summarizeData } from './dataSources.js'
import type { KernelHandles, PageSurface, SurfaceRenderContext } from './surface.js'
import type {
  CreateRuntimeOptions,
  NavigationResult,
  NavigationTarget,
  NormalizedManifest,
  RouterBridge,
  RouterBridgeApi,
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

/** 等一次导航提交的兜底超时（host 模式的 router.go 不返回 Promise） */
const EXTERNAL_GO_TIMEOUT_MS = 400

export interface KernelDeps {
  options: CreateRuntimeOptions
  /** 装配渲染面（由 runtime.ts 决定 container / host） */
  createSurface: (handles: KernelHandles) => PageSurface
}

export function createKernel(deps: KernelDeps): Runtime {
  const { options } = deps
  const wantsHostSurface = options.surface === 'host'
  const bus: EventBus = createEventBus()
  const servicesRef: MutableServicesRef = createServicesRef(options.services ?? {})
  // host 模式：真实 URL 是最终裁决 → 内核只维护「当前页」一个槽位（避免与宿主 history 发散）
  const nav: NavigationController = createNavigationController([], {
    history: wantsHostSurface ? 'external' : 'internal',
  })

  // ---- NetworkObserver：拦截 fetch / XHR，广播 observation 事件 ----（默认关闭，避免无差别暴露）
  const observer = createNetworkObserver({
    context: () => ({
      page: nav.current?.tag,
      navigationId: nav.navigationId || undefined,
    }),
    autoStart: options.observeNetwork === true,
  })
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
    const snapshot = { page, source, data, truncated, at: Date.now() }
    bus.emit('page-data', snapshot)
    servicesRef.current.reportApiData?.(snapshot)
  })

  let manifest: NormalizedManifest | null = null
  let surface: PageSurface | null = null
  let status: RuntimeStatus = 'idle'
  let error: RuntimeErrorInfo | undefined
  let disposed = false
  let ready = false
  let lastCommitAt = 0
  /** 下一次 render 的上下文（replace / source 由发起导航的那一跳决定） */
  let renderCtx: SurfaceRenderContext = { replace: true, source: 'host' }
  /** 框架 router 桥（container: memory router；host: 宿主真实 router 的回流部分） */
  const bridges = new Map<string, RouterBridge>()

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
      styles: surface ? surface.styles() : [],
      stylesVersion: surface ? surface.stylesVersion : 0,
      status,
      error,
      title: route?.title,
      events: route?.events ?? [],
    }
  }

  /** 把当前视图落到渲染面并广播 view 事件 */
  function render(): RuntimeView {
    const view = buildView()
    // 没有当前页（framework / tag 为空）时不做任何渲染动作（与容器模式的懒建语义一致）
    if (surface && view.framework && view.tag) {
      const ctx = renderCtx
      try {
        void Promise.resolve(surface.render(view, ctx)).catch((cause: unknown) => {
          fail({
            message: `渲染面渲染失败：${(cause as Error)?.message ?? String(cause)}`,
            tag: view.tag ?? undefined,
            framework: view.framework ?? undefined,
            cause,
          })
        })
      } catch (cause) {
        fail({
          message: `渲染面渲染失败：${(cause as Error)?.message ?? String(cause)}`,
          tag: view.tag ?? undefined,
          framework: view.framework ?? undefined,
          cause,
        })
      }
    }
    bus.emit('view', view)
    return view
  }

  function setStatus(next: RuntimeStatus, keepError = false): void {
    status = next
    if (!keepError && next !== 'error') error = undefined
    bus.emit('status', { status, tag: nav.current?.tag ?? null })
  }

  /** 可回退判定：宿主给了真实历史就以它为准（host 模式），否则用内核自己的 entries */
  function canGoBackNow(): boolean {
    return surface?.history ? surface.history.canGoBack : nav.canGoBack
  }

  function canGoForwardNow(): boolean {
    return surface?.history ? surface.history.canGoForward : nav.canGoForward
  }

  function findRoute(tag: string): RuntimeRoute | undefined {
    return nav.routes.find((route) => route.tag === tag)
  }

  /**
   * 取当前页（或指定页）的 `defineExpose` 对象。
   * 渲染面返回 `undefined` = 不支持 expose；`null` = 支持但没有可读实例。
   * 仅保留函数字段：保证上层（chat-client / agent）拿到的就是可调用方法集合。
   */
  function getPageExposedRuntime(page?: string): Record<string, unknown> | null {
    if (!surface || !ready) return null
    const targetTag = page ?? nav.current?.tag
    if (!targetTag || !findRoute(targetTag)) return null
    if (typeof surface.getPageExposed !== 'function') return null
    const raw = surface.getPageExposed(targetTag)
    if (!raw || typeof raw !== 'object') return null
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'function') out[key] = value
    }
    return out
  }

  /** 视图就绪后调一次：广播当前页 expose 的方法名清单（函数不可序列化） */
  function broadcastPageExposed(tag: string): void {
    if (typeof surface?.getPageExposed !== 'function') return
    const exposed = surface.getPageExposed(tag)
    if (exposed === undefined) return // 该渲染面不支持 expose：不广播
    const record = exposed as Record<string, unknown> | null
    const keys = record
      ? Object.keys(record).filter((key) => typeof record[key] === 'function')
      : []
    bus.emit('page-exposed-changed', { tag, keys })
  }

  /** 为渲染面建「页面内导航 → 内核」的桥（container: memory router；host: 真实 router 回流） */
  async function ensureBridge(framework: string): Promise<void> {
    if (bridges.has(framework)) return
    if (typeof surface?.bindRouter !== 'function') return
    const api: RouterBridgeApi = {
      routes: nav.routes,
      canNavigate: (target) => nav.canNavigate({ ...target, source: target.source ?? 'page' }),
      commit: (target) => applyNavigation({ ...target, source: target.source ?? 'page' }, true),
    }
    const bridge = surface.bindRouter(framework, api)
    if (bridge) bridges.set(framework, bridge)
  }

  /** 落地后的渲染流程：先按已就绪状态出一帧，未就绪则 loading → ready 两帧 */
  async function settle(
    location: RuntimeLocation,
    route: RuntimeRoute,
    fromBridge: boolean,
    replace: boolean,
  ): Promise<NavigationResult> {
    const loaded = surface!.isReady(route)
    lastCommitAt = Date.now()
    renderCtx = { replace, source: location.source }
    setStatus(loaded ? 'ready' : 'loading')
    render()

    if (!loaded) {
      try {
        await surface!.prepare(route)
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
      canGoBack: canGoBackNow(),
      canGoForward: canGoForwardNow(),
    })
    if (!fromBridge) {
      // 桥的 apply 可能被宿主拒绝（守卫/路由未注册/网络）：转成结构化失败，不要以 rejection 冒泡
      const bridge = bridges.get(route.framework)
      if (bridge) {
        try {
          await bridge.apply(location, replace)
        } catch (cause) {
          const detail = (cause as Error)?.message ?? String(cause)
          fail({ message: detail, framework: route.framework, tag: route.tag, cause })
          return { ok: false, reason: 'load-failed', detail }
        }
      }
    }
    // 视图就绪后广播当前页 expose 能力清单（agent call_page_method 的依据）
    broadcastPageExposed(route.tag)
    return { ok: true, location, route, duplicated: false }
  }

  async function applyNavigation(
    target: NavigationTarget,
    fromBridge = false,
  ): Promise<NavigationResult> {
    assertActive()
    if (!surface || !ready) {
      return { ok: false, reason: 'aborted', detail: 'runtime 尚未 init' }
    }
    const resolved = nav.resolve(target)
    if (!resolved.ok) {
      fail({ message: `导航失败：${resolved.detail ?? resolved.reason}` })
      return resolved
    }
    // 渲染面「此刻能不能渲染这一页」（host: 宿主 router 是否注册了该路由 —— 可能是登录/权限尚未到位）。
    // 在 commit 之前拦下：不推进内核状态，避免「内核以为切了页、宿主 URL 没动」的分裂。
    const blocked = surface.canRender?.(resolved.route)
    if (blocked) {
      fail({ message: blocked, tag: resolved.route.tag, framework: resolved.route.framework })
      return { ok: false, reason: 'not-found', detail: blocked }
    }
    try {
      // 框架级就绪（container: 容器 + 框架 router 桥；host: 校验 framework 归属）
      await surface.ensure(resolved.route.framework)
      await ensureBridge(resolved.route.framework)
    } catch (cause) {
      // 错误文案由渲染面给出（容器模式为「容器加载失败（framework=…）」，宿主模式另有措辞）
      const detail = (cause as Error)?.message ?? String(cause)
      fail({ message: detail, framework: resolved.route.framework, cause })
      return { ok: false, reason: 'load-failed', detail }
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
    // host 模式：真实历史是最终裁决，内核只镜像（委托宿主 go）
    if (surface?.history) return goExternal(delta)
    const result = nav.go(delta)
    if (!result.ok) return result
    return settle(result.location, result.route, false, true)
  }

  /**
   * host 模式的前进 / 后退：`router.go()` 不返回 Promise，因此「等一次提交（或超时）」再判定 ——
   * 没有提交 = 越界或被宿主守卫拦下（不悬挂、不误报成功）。
   */
  async function goExternal(delta: number): Promise<NavigationResult> {
    if (!delta) return { ok: false, reason: 'out-of-range', detail: 'delta 不能为 0' }
    const history = surface?.history
    if (!history) return { ok: false, reason: 'out-of-range', detail: '宿主历史不可用' }
    const before = nav.navigationId
    const moved = new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        stop()
        resolve()
      }
      const stop = nav.subscribe(finish)
      setTimeout(finish, EXTERNAL_GO_TIMEOUT_MS)
    })
    await history.go(delta)
    await moved
    if (nav.navigationId === before) {
      return { ok: false, reason: 'out-of-range', detail: `history 未移动：${delta}` }
    }
    const location = nav.current
    const route = nav.currentRoute
    if (!location || !route) return { ok: false, reason: 'out-of-range' }
    return { ok: true, location, route, duplicated: false }
  }

  const navApi: RuntimeNavApi = {
    push: (target) => applyNavigation({ ...target, source: target.source ?? 'page' }),
    replace: (target) => applyNavigation({ ...target, replace: true, source: target.source ?? 'page' }),
    back: () => goInternal(-1),
    forward: () => goInternal(1),
    go: (delta) => goInternal(delta),
    current: () => nav.current,
    get canGoBack() {
      return canGoBackNow()
    },
    get canGoForward() {
      return canGoForwardNow()
    },
  }

  /** 交给渲染面的句柄（稳定引用；路由表实时读） */
  const handles: KernelHandles = {
    navigation: navApi,
    servicesRef,
    observer,
    routes: () => nav.routes,
    onPageEvent: (payload) => bus.emit('page-event', payload),
    broadcastExposed: (tag) => broadcastPageExposed(tag),
    canNavigate: (target) => nav.canNavigate({ ...target, source: target.source ?? 'page' }),
    commit: (target) => applyNavigation({ ...target, source: target.source ?? 'page' }, true),
  }

  async function init(root?: Element | null): Promise<void> {
    assertActive()
    if (ready) {
      surface?.mount(root ?? null)
      return
    }
    const raw =
      options.manifest ??
      (options.manifestUrl ? await loadManifestJson(options.manifestUrl, options.fetchImpl) : null)
    if (!raw) throw new Error('createRuntime 需要 manifest 或 manifestUrl')

    surface = deps.createSurface(handles)
    manifest = normalizeManifest(raw, {
      assetBase: options.assetBase,
      preRegisteredFrameworks: [
        ...(options.adapters ?? []).map((adapter) => adapter.framework),
        ...(surface.framework ? [surface.framework] : []),
      ],
      forHostSurface: wantsHostSurface,
      defaultFramework: surface.framework ?? undefined,
    })
    nav.setRoutes(manifest.routes)
    await surface.attach(manifest, root ?? null)
    ready = true

    // 渲染面自带框架 router 时，init 就要把桥装上 —— 否则「init 期间/之前发生的框架导航」
    // 永远不会回流内核。container 模式用的是页面内的 memory router（framework 为 null → 跳过，
    // 仍保持「首次导航时懒建」）；host 模式用的是宿主真实 router，它随时可能导航（如重定向）。
    if (surface.framework) await ensureBridge(surface.framework)

    if (options.preload === 'all') {
      for (const route of manifest.routes) {
        try {
          await surface.prepare(route)
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

    // host 模式：把宿主**当前路由**纳入内核（agent 首轮决策就知道用户在哪个页面）
    const adopted = options.adopt === false ? null : surface.snapshot?.() ?? null
    const first = manifest.routes[0]
    // host 模式的「页面」由宿主的 URL 决定：不传 initial 时不自动打开任何页面（避免 runtime 抢改地址栏）
    const initial =
      options.initial === null || (options.initial === undefined && wantsHostSurface)
        ? null
        : options.initial ?? (first ? { tag: first.tag } : null)
    if (adopted) {
      await applyNavigation({ ...adopted, replace: true, source: adopted.source ?? 'initial' })
    } else if (initial) {
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
      return canGoBackNow()
    },
    get canGoForward() {
      return canGoForwardNow()
    },
    /**
     * 有没有页面。`container` 模式 = 渲染区有没有渲染出子 WC（`false` → 宿主展示欢迎页）；
     * `host` 模式 = 当前路由是否命中页面目录。
     * 注意区分「导航过」与「有页面」：页面加载失败时仍是 `true`（有当前页，只是状态为 error）。
     */
    get hasPage() {
      return nav.currentRoute !== null
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
      renderCtx = { replace: true, source: 'host' }
      render()
      // 已有当前页时，路由变化可能改了暴露面（同名 tag 不同 bundle），重新广播
      const currentRoute = nav.currentRoute
      if (currentRoute) broadcastPageExposed(currentRoute.tag)
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
      // 渲染面自己收尾（container: 卸载容器 + 释放样式登记 + 清页级 scope）
      surface?.dispose()
      surface = null
      nav.dispose()
      observer.dispose()
      servicesRef.dispose()
      bus.clear()
    },
  }
}
