// 渲染宓主：把 runtime 的生命周期与事件包成 Vue 响应式状态。
// manifest 加载、容器懒建、bundle 动态 import、样式注入、history、params→props 全在 runtime 里，
// 宿主只需提供一个挂载点 + services。
import { computed, onMounted, onUnmounted, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { createHostRuntime } from '@webassistant/wc-runtime-vue/host'
import {
  activityBus,
  currentActivityOrigin,
  isActivityTraced,
  type WcActivity,
  type WcActivityInput,
} from '@webassistant/wc-runtime-vue/host'
import type {
  NavigationResult,
  NavigationTarget,
  NetworkObservation,
  Runtime,
  RuntimeErrorInfo,
  RuntimeRoute,
  RuntimeServices,
  RuntimeStatus,
  RuntimeSurfaceKind,
} from '@webassistant/wc-runtime-vue/host'
import type { PageEventPayload, PageChangeInfo, WebAssistantRuntimeContext } from '../types.js'
import { resolveInitialTarget } from '../lib/initialPage.js'

export interface UseRuntimeHostOptions {
  /** manifest 在 {wcBase}/manifest.json，产物在 {wcBase}/dist-ce */
  wcBase: () => string
  /**
   * 渲染面（用法）：`container`（缺省，WC 用法）/ `host`（宿主直连用法）。
   */
  surface?: RuntimeSurfaceKind
  /**
   * runtime 构造注入口。给了就用它造 runtime（host 模式必填，宿主在这里塞真实 router）；
   * 不给则按 `wcBase` 拉 manifest + dist-ce（container 模式现状）。
   */
  createRuntime?: (context: WebAssistantRuntimeContext) => Runtime
  /**
   * 首屏是否自动打开页面：
   * - 缺省 / `false`：不自动打开 → 渲染区展示「欢迎页」（由用户对话或 agent 决定打开哪个页面）
   * - `true`：自动打开 manifest 的第一个页面（runtime 原有的默认行为）
   * - 字符串：自动打开指定 tag 的页面
   */
  initialPage?: boolean | string
  services?: RuntimeServices
  onPageChange?: (info: PageChangeInfo) => void
  onPageEvent?: (payload: PageEventPayload) => void
  /** 页面网络观察事件（fetch/XHR 被拦截后回调；宿主可转给 agent-server，方案 B 一般不走此路） */
  onNetworkObservation?: (observation: NetworkObservation) => void
  /** 页面 apiBus.report() 上报的数据快照（方案 B 主通道：宿主转发给 agent-server） */
  onPageData?: (snapshot: { page?: string; source: string; data: unknown; truncated: boolean; at: number }) => void
  /**
   * 页面 `defineExpose` 能力清单变化（runtime 广播 'page-exposed-changed'）。
   * chat-client 用它把当前页可调用方法同步给 agent-server，agent 据此规划 call_page_method。
   */
  onPageExposed?: (info: { tag: string; keys: string[] }) => void
  onError?: (error: RuntimeErrorInfo) => void
  /**
   * 「WC 执行监视」回调：WC 侧发生的活动（方法调用 / 导航 / emit / 数据上报 / 网络 / 错误）
   * 逐条回调。与 `activities` 响应式列表是同一份数据（activityBus 全局单例）。
   */
  onActivity?: (activity: WcActivity) => void
  /** 本地活动缓冲上限（缺省取 activityBus.limit，200） */
  activityLimit?: number
  /** 调试模式：把 runtime 挂到 globalThis.__waRuntime（控制台可直接 getPageExposed / callPageMethod） */
  debug?: boolean
}

export interface UseRuntimeHostReturn {
  /** 挂在渲染区域的 div 上 */
  mountEl: Ref<HTMLElement | null>
  title: Ref<string>
  /**
   * 渲染区是否由页面（子 WC）接管。判据来自 runtime 的 `view.tag`：
   * `false` ⇔ runtime 没有渲染任何子 WC ⇔ 渲染区空态（宿主应显示欢迎页）。
   */
  hasPage: Ref<boolean>
  /** runtime 当前页 tag；null = 没有渲染子 WC（同 hasPage === false） */
  currentTag: Ref<string | null>
  /** 本地 manifest 是否已 settle（加载成功或失败都算）——欢迎页据此退出加载态 */
  manifestSettled: Ref<boolean>
  canGoBack: Ref<boolean>
  status: Ref<RuntimeStatus>
  error: Ref<RuntimeErrorInfo | null>
  routes: Ref<readonly RuntimeRoute[]>
  /**
   * 当前页（最新一次广播过 page-exposed-changed 的 tag）的 expose 方法 key 列表。
   * 供 chat-client 透传给 agent-server 作为 call_page_method 的能力清单。
   */
  currentPageExposedKeys: Ref<string[]>
  /** 当前页 tag（最近一次广播过的） */
  currentPageExposedTag: Ref<string | null>
  navigate: (target: NavigationTarget) => Promise<NavigationResult | undefined>
  back: () => void
  /**
   * 宿主侧 runtime 实例（`init` 之后可用，卸载后回到 null）。
   *
   * 宿主需要「反向推数据给页面」时用它 —— 都是 runtime 的框架无关 API：
   * ```ts
   * runtime.value?.setState({ user: { name: '张三' } })      // 业务状态快照（页面 context.state 响应式跟上）
   * runtime.value?.setServices({ getToken })                // 中途换/补宿主能力
   * runtime.value?.getPageExposed()                         // 当前页 defineExpose 的方法
   * ```
   * 「宿主 pinia → CE 页面 store」的快照桥推手也接它：
   * `createHostStorePusher({ getRuntime: () => runtime.value })`（见 @webassistant/wc-runtime-vue/host）。
   */
  runtime: ShallowRef<Runtime | null>
  setState: (patch: Record<string, unknown>) => void
  setServices: (patch: Partial<RuntimeServices>) => void
  /**
   * 调用页面通过 `defineExpose` 暴露的方法。
   * - page 不传：当前页
   * - page 传了：已渲染过的指定 tag
   * 返回结构化结果：成功 { ok:true, value }，失败 { ok:false, error }。
   */
  callPageMethod: <T = unknown>(name: string, args?: unknown[], page?: string) => Promise<
    | { ok: true; value: T; async: boolean }
    | { ok: false; error: string }
  >
  /**
   * WC 活动时间线（**最新在前**，环形缓冲）。含 `kind:'call'` 的执行记录
   * （方法名 / 入参 / 耗时 / 结果 / 错误 / origin）与 navigate / emit / data / exposed / network / error。
   */
  activities: Ref<WcActivity[]>
  /** 清空活动时间线（同时清 activityBus 的全局缓冲） */
  clearActivities: () => void
}

export function useRuntimeHost(options: UseRuntimeHostOptions): UseRuntimeHostReturn {
  const mountEl = ref<HTMLElement | null>(null)
  const title = ref('')
  // 「有没有页面」唯一真相源 = runtime 的 view.tag（= 有没有渲染子 WC），不是「导航过没有」。
  const currentTag = ref<string | null>(null)
  const hasPage = computed(() => currentTag.value !== null)
  const manifestSettled = ref(false)
  const canGoBack = ref(false)
  const status = ref<RuntimeStatus>('idle')
  const error = ref<RuntimeErrorInfo | null>(null)
  const routes = shallowRef<readonly RuntimeRoute[]>([])
  const currentPageExposedKeys = shallowRef<string[]>([])
  const currentPageExposedTag = ref<string | null>(null)
  /** WC 活动时间线（最新在前） */
  const activities = shallowRef<WcActivity[]>([])
  const activityLimit = options.activityLimit ?? activityBus.limit
  let stopActivities: (() => void) | null = null

  /** 宿主侧合成的活动（`kind:'call'` 由容器包裹层上报，这里补事件类，避免重复记账） */
  const record = (input: WcActivityInput): void => {
    activityBus.report(input)
  }

  let runtime: Runtime | null = null
  /** 给宿主的 runtime 句柄（init 后可用、卸载后回 null） */
  const runtimeRef = shallowRef<Runtime | null>(null)

  onMounted(async () => {
    const base = options.wcBase()
    // 先订阅活动总线：runtime.init 触发的首屏导航也要落到时间线里
    activities.value = activityBus.snapshot().slice(0, activityLimit)
    stopActivities = activityBus.on((activity) => {
      const next = [activity, ...activities.value]
      activities.value = next.length > activityLimit ? next.slice(0, activityLimit) : next
      options.onActivity?.(activity)
    })

    // runtime 默认会「自动打开 manifest 第一个页面」；chat-client 默认改为不打开（`initial: null`），
    // 让渲染区先展示欢迎页。宿主可用 `initialPage` 恢复/指定首屏页面。
    const initial = resolveInitialTarget(options.initialPage)
    const surface = options.surface ?? 'container'
    runtime = options.createRuntime
      ? // host 模式（宿主直连）：runtime 由宿主注入（createVueHostRuntime）—— 面板不负责页面渲染
        options.createRuntime({ base, initial: initial ?? null, surface } satisfies WebAssistantRuntimeContext)
      : createHostRuntime({
          manifestUrl: `${base}/manifest.json`,
          assetBase: `${base}/dist-ce`,
          services: options.services,
          initial,
        })
    runtimeRef.value = runtime

    // 调试模式：把 runtime 交给控制台（与容器同一条 getPageExposed 入口，便于手动触发一次调用）
    if (options.debug) {
      Object.defineProperty(globalThis, '__waRuntime', { configurable: true, get: () => runtime })
    }

    // 「有没有页面」以 runtime 的视图为准：view.tag === null ⇔ 没有渲染子 WC（渲染区空态 → 欢迎页）。
    // 不能用 navigate 事件代替 —— 那只是「发生过导航」：页面加载失败也不回退，且再也回不到空态。
    runtime.on('view', (view) => {
      currentTag.value = view.tag
    })
    runtime.on('navigate', ({ location, route, source, canGoBack: back }) => {
      title.value = route.title ?? route.tag
      canGoBack.value = back
      options.onPageChange?.({
        tag: route.tag,
        title: route.title,
        source,
        canGoBack: back,
        params: location.params,
      })
      record({ kind: 'navigate', tag: route.tag, name: location.path, args: { source, params: location.params } })
    })
    runtime.on('status', (payload) => {
      status.value = payload.status
    })
    runtime.on('page-event', (payload) => {
      options.onPageEvent?.(payload)
      record({ kind: 'emit', tag: payload.tag, name: payload.event, args: payload.payload })
    })
    runtime.on('network-observation', (observation) => {
      options.onNetworkObservation?.(observation)
      record({ kind: 'network', tag: observation.page ?? undefined, name: observation.type, args: observation })
    })
    runtime.on('page-data', (snapshot) => {
      options.onPageData?.(snapshot)
      record({
        kind: 'data',
        tag: snapshot.page ?? undefined,
        name: snapshot.source,
        args: { data: snapshot.data, truncated: snapshot.truncated },
      })
    })
    runtime.on('page-exposed-changed', (info) => {
      currentPageExposedKeys.value = info.keys
      currentPageExposedTag.value = info.tag
      options.onPageExposed?.(info)
      record({ kind: 'exposed', tag: info.tag, args: info.keys })
    })
    runtime.on('error', (payload) => {
      error.value = payload
      options.onError?.(payload)
      record({ kind: 'error', name: payload.message })
    })

    try {
      if (!options.createRuntime && !mountEl.value) throw new Error('渲染容器未就绪')
      // host 模式没有面板内渲染区（页面在宿主自己的位置渲染）→ 不传挂载点
      await runtime.init(options.createRuntime ? null : mountEl.value)
      routes.value = runtime.routes
      manifestSettled.value = true
    } catch (cause) {
      const info: RuntimeErrorInfo = {
        message: `runtime 初始化失败：${(cause as Error).message}`,
        cause,
      }
      error.value = info
      options.onError?.(info)
      // 失败也算 settle：否则欢迎页会永远停在「加载中」而不是给出空态提示
      manifestSettled.value = true
    }
  })

  onUnmounted(() => {
    stopActivities?.()
    stopActivities = null
    if (options.debug) Reflect.deleteProperty(globalThis, '__waRuntime')
    runtime?.dispose()
    runtime = null
    runtimeRef.value = null
  })

  return {
    mountEl,
    title,
    hasPage,
    currentTag,
    manifestSettled,
    canGoBack,
    status,
    error,
    routes,
    currentPageExposedKeys,
    currentPageExposedTag,
    navigate: (target) => Promise.resolve(runtime?.navigate(target)),
    back: () => void runtime?.back(),
    runtime: runtimeRef,
    setState: (patch) => runtime?.setState(patch),
    setServices: (patch) => runtime?.setServices(patch),
    activities,
    clearActivities: () => {
      activityBus.clear()
      activities.value = []
    },
    async callPageMethod<T = unknown>(name: string, args?: unknown[], page?: string): Promise<
      | { ok: true; value: T; async: boolean }
      | { ok: false; error: string }
    > {
      // origin 由调用方用 withActivityOrigin('agent', ...) 标好（agent 路径见 useWebAssistant）
      const origin = currentActivityOrigin()
      const recordFailure = (error: string): { ok: false; error: string } => {
        record({ kind: 'call', tag: page, name, args: args?.length ? args : undefined, origin, ok: false, error })
        return { ok: false, error }
      }
      if (!runtime) return recordFailure('runtime 未就绪')
      const exposed = runtime.getPageExposed(page)
      if (!exposed) {
        return recordFailure(page ? `页面 ${page} 未渲染或不支持 expose` : '当前页未渲染或不支持 expose')
      }
      const fn = exposed[name]
      if (typeof fn !== 'function') {
        return recordFailure(`方法 ${name} 未在 ${page ?? '当前页'} 暴露`)
      }
      // 容器侧包裹过的函数自己会往 activityBus 记账（含 args/耗时/返回值）；
      // 未包裹的（例如尚未实现包裹的其它 framework adapter）在这里补一条，保证不漏。
      const traced = isActivityTraced(fn)
      const startedAt = Date.now()
      try {
        const returned = (fn as (...a: unknown[]) => unknown).apply(null, args ?? [])
        // 显式判定返回类型：Promise → 等其 resolve；非 Promise → 直接取返回值（两者都算成功）。
        const isAsync = typeof (returned as { then?: unknown } | null | undefined)?.then === 'function'
        const value = (isAsync ? await (returned as Promise<T>) : returned) as T
        if (!traced) {
          record({
            kind: 'call',
            tag: page,
            name,
            args: args?.length ? args : undefined,
            origin,
            ok: true,
            durationMs: Date.now() - startedAt,
            result: value,
          })
        }
        return { ok: true, value, async: isAsync }
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause)
        if (!traced) {
          record({ kind: 'call', tag: page, name, args: args?.length ? args : undefined, origin, ok: false, error })
        }
        return { ok: false, error }
      }
    },
  }
}
