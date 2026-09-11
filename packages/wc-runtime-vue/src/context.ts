// 注入键与页面侧消费入口。
// 用 Symbol.for 是有意的：同一批次内本来就是单副本（symbol 相同），
// 万一出现多副本（比如宿主也装了本包），全局注册表仍能对齐。
import { inject, type App, type InjectionKey, type ShallowReactive } from 'vue'
import type { RuntimeNavApi, RuntimeServices, ServicesRef, NetworkObserver, ApiReport } from '@webassistant/wc-runtime-core'
import { apiBus } from '@webassistant/wc-runtime-core'

export interface RuntimeServicesContext {
  /** 外层传入的服务（稳定引用，内容可被 setServices 替换） */
  readonly services: RuntimeServices
  /** 宿主业务状态：runtime 侧自己的浅响应式副本，setState 后会同步 */
  readonly state: ShallowReactive<Record<string, unknown>>
  /** 框架无关导航 API */
  readonly nav: RuntimeNavApi
  /** 网络观察器（与容器同一实例；页面一般用不到，但保留以备后用） */
  readonly observer: NetworkObserver
  /** i18n 翻译函数（缺省时原样返回 key，便于本地跑） */
  t(key: string, ...args: unknown[]): string
  /** 宿主注入的请求实例 */
  readonly request: unknown
  /** 页面事件回传宿主（宿主可转发给 agent） */
  emit(event: string, payload?: unknown): void
  /** 页面主动上报数据（内部调 apiBus.report） */
  reportApiData(payload: ApiReport): void
}

export const RUNTIME_CONTEXT_KEY = Symbol.for(
  'webassistant.runtime.context',
) as InjectionKey<RuntimeServicesContext>

export function createRuntimeContext(
  servicesRef: ServicesRef,
  nav: RuntimeNavApi,
  state: ShallowReactive<Record<string, unknown>>,
  observer: NetworkObserver,
): RuntimeServicesContext {
  return {
    get services() { return servicesRef.current },
    state,
    nav,
    observer,
    t(key, ...args) {
      const translate = servicesRef.current.t
      return typeof translate === 'function' ? translate(key, ...args) : key
    },
    get request() { return servicesRef.current.request },
    emit(event, payload) { servicesRef.current.emit?.(event, payload) },
    reportApiData(payload) { apiBus.report(payload) },
  }
}

/** 把 context 与 $tt / $t 挂到一个 app 上（容器与每个页面 app 都要挂） */
export function provideRuntimeContext(app: App, context: RuntimeServicesContext): void {
  app.provide(RUNTIME_CONTEXT_KEY, context)
  const translate = (key: string, ...args: unknown[]) => context.t(key, ...args)
  app.config.globalProperties.$tt = translate
  if (!app.config.globalProperties.$t) app.config.globalProperties.$t = translate
  if (typeof window !== 'undefined') {
    ;(window as Window & { $tt?: typeof translate }).$tt ??= translate
  }
}

/** 页面里消费 runtime 注入的一切：const { request, t, state, nav } = useRuntimeServices() */
export function useRuntimeServices(): RuntimeServicesContext {
  const context = tryUseRuntimeServices()
  if (!context) {
    throw new Error(
      '[wc-runtime-vue] useRuntimeServices 必须在 runtime 容器内的页面中使用（未找到注入的 context）',
    )
  }
  return context
}

/**
 * 可选版本：拿不到就返回 null。
 * 用于「同一个页面组件既在 runtime 容器里跑，也在原项目 SPA 里跑」的场景。
 */
export function tryUseRuntimeServices(): RuntimeServicesContext | null {
  return inject(RUNTIME_CONTEXT_KEY, null)
}
