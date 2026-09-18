// 宿主直连渲染面（用法 B）：agent 的导航落到宿主**真实 vue-router**，页面在宿主自己的 <router-view> 渲染。
//
// 与 container 模式（WC）的分工差异：
//   - 不出 bundle、不注册自定义元素、不 patch 容器、不做样式隔离
//   - 出向导航复用 routerSync 的三机制（host 模式 registerRoutes: false —— 绝不 addRoute）
//   - props 只能走旁路（真实 router 承载不了对象）：写进浅响应式的 pageProps，
//     页面用 `useRuntimeServices().pageProps` 读
//   - 历史委托宿主（history.state.position / router.go）：真实 URL 是最终裁决
//   - emit 无法自动捕获（没有 CE 边界）→ 页面显式 `useRuntimeServices().emit()`
import { shallowReactive, nextTick, type App } from 'vue'
import type { Router, RouteLocationNormalizedLoaded } from 'vue-router'
import type {
  HostSurface,
  HostSurfaceRuntimeApi,
  RuntimeLocation,
  RuntimeRoute,
  RuntimeView,
} from '@webassistant/wc-runtime-core'
import { createRuntimeContext, RUNTIME_CONTEXT_KEY } from './context.js'
import { createRouterSync, type VueRouterSync } from './routerSync.js'

export interface VueHostSurfaceOptions {
  /** 宿主的真实 vue-router（web / hash 历史都行） */
  router: Router
  /**
   * 宿主 app：给了就把 runtime context `provide` 进去（`useRuntimeServices()` 由 null 变可用）。
   * 注意只 provide `RUNTIME_CONTEXT_KEY`，**不覆盖**宿主的 `$tt` / `$t` 全局属性。
   */
  app?: App
  /** 是否把直传 props 走响应式旁路下发（缺省 true；页面读 `useRuntimeServices().pageProps`） */
  passProps?: boolean
}

export interface VueHostSurface extends HostSurface {
  /** 旁路 props（浅响应式；与 provide 给页面的 context.pageProps 是同一份引用） */
  readonly pageProps: Record<string, unknown>
}

/** vue-router 写在 `history.state` 里的自有字段（createWebHistory / createWebHashHistory 都会写） */
interface VueRouterHistoryState {
  position?: number
  back?: string | null
  forward?: string | null
}

function readHistoryState(): VueRouterHistoryState | null {
  if (typeof window === 'undefined') return null
  const state = window.history?.state as VueRouterHistoryState | null | undefined
  return state ?? null
}

/** 同参数判定（用于「已是当前路由 → 不重复导航」） */
function sameParams(current: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  for (const key of keys) {
    if (String(current[key] ?? '') !== String(next[key] ?? '')) return false
  }
  return true
}

function sameQuery(current: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  for (const key of keys) {
    if (JSON.stringify(current[key] ?? '') !== JSON.stringify(next[key] ?? '')) return false
  }
  return true
}

/**
 * 造一个宿主直连渲染面。
 * 典型用法（宿主 main.ts / App.vue）：用 `createVueHostRuntimeBinding({ router, app, services })`（推荐），
 * 或 `const hostSurface = createVueHostSurface({ router, app })` 后自己交给 createRuntime。
 */
export function createVueHostSurface(options: VueHostSurfaceOptions): VueHostSurface {
  const { router } = options
  const pageProps = shallowReactive<Record<string, unknown>>({})
  let runtimeApi: HostSurfaceRuntimeApi | null = null
  let sync: VueRouterSync | null = null
  /** 上次广播过的 expose key 串（避免同一份能力重复广播） */
  let lastExposedKeys = ''

  /** 当前页的 core tag（由内核维护的导航真相源给出） */
  function currentTag(): string | null {
    return runtimeApi?.navigation.current()?.tag ?? null
  }

  /** core tag → 宿主 route name（两者通常不同：`datasource-admin` ↔ `DatasourceAdmin`） */
  function nameForTag(tag: string): string {
    const route = (runtimeApi?.routes() ?? []).find((item) => item.tag === tag)
    return route?.name ?? tag
  }

  /** 宿主 route name → core tag（回流广播 expose 时用） */
  function tagForName(name: string): string | null {
    const route = (runtimeApi?.routes() ?? []).find((item) => item.name === name)
    return route?.tag ?? null
  }

  function readExposed(tag: string): Record<string, unknown> | null {
    const loaded = router.currentRoute.value as
      | (RouteLocationNormalizedLoaded & { matched: Array<{ instances?: Record<string, unknown> }> })
      | undefined
    if (!loaded) return null
    if (loaded.name != null && String(loaded.name) !== nameForTag(tag)) return null // 非当前页
    // 从最深一层 matched 往上找第一个挂载了组件实例的记录（页面内嵌套路由时取最内层）
    for (const record of [...loaded.matched].reverse()) {
      const instance = record.instances?.default as
        | {
            exposed?: Record<string, unknown> | null
            /** Vue 3.5 的组件 ref 拿到的是 **expose proxy**，原始 exposed 对象在 `$.exposed`
             *（实测：CE 上是 `_instance.exposed`，普通组件上是 `$.exposed`） */
            $?: { exposed?: Record<string, unknown> | null }
          }
        | null
        | undefined
      const exposed = instance?.exposed ?? instance?.$?.exposed ?? null
      if (exposed && typeof exposed === 'object') return exposed
    }
    return null
  }

  function exposedKeys(tag: string): string[] {
    const exposed = readExposed(tag)
    if (!exposed) return []
    return Object.keys(exposed).filter((key) => typeof exposed[key] === 'function')
  }

  /** 页面挂载可能晚于本轮导航 → 挂载后若能力清单变了，请内核补广播一次 */
  function rebroadcastIfChanged(tag: string): void {
    const signature = exposedKeys(tag).join(',')
    if (signature === lastExposedKeys) return
    lastExposedKeys = signature
    runtimeApi?.broadcastExposed(tag)
  }

  /** 「已是当前路由」→ 不重复 push（避免多余历史条目 / 重复导航与重复请求） */
  function pushIfChanged(location: RuntimeLocation, replace: boolean): void | Promise<void> {
    const current = router.currentRoute.value
    if (
      current?.name != null &&
      String(current.name) === location.name &&
      sameParams(current.params as Record<string, unknown>, location.params) &&
      sameQuery(current.query as Record<string, unknown>, location.query)
    ) {
      return
    }
    const target = {
      name: location.name,
      params: location.params as never,
      query: location.query as never,
    }
    const task = replace ? router.replace(target) : router.push(target)
    return task.catch(() => undefined).then(() => undefined)
  }

  function syncPageProps(props: Record<string, unknown>): void {
    if (options.passProps === false) return
    for (const key of Object.keys(pageProps)) {
      if (!(key in props)) delete pageProps[key]
    }
    Object.assign(pageProps, props)
  }
  return {
    framework: 'vue',
    pageProps,

    bindRuntime(api) {
      runtimeApi = api
      const app = options.app
      if (!app) return
      // state 走与 container 同款的「浅响应式镜像」（宿主 store 与 runtime 是两份副本，只能推快照）
      const state = shallowReactive<Record<string, unknown>>({ ...api.servicesRef.state })
      api.servicesRef.subscribe((ref, change) => {
        if (change.kind !== 'state') return
        for (const key of change.keys) state[key] = ref.state[key]
      })
      const context = createRuntimeContext(
        api.servicesRef,
        api.navigation,
        state,
        pageProps,
      )
      // 只注入 runtime context：**不**用 provideRuntimeContext（那会顶掉宿主自己的 $tt / $t）
      app.provide(RUNTIME_CONTEXT_KEY, context)
    },

    validateRoutes(routes: readonly RuntimeRoute[]): void {
      // 只在 init 时**报出**（不抛错）：真实项目的页面路由常是登录后 / 按权限才注册的
      // （vben 的 access routes 就是这样），init 时它们不存在很正常。
      // 真正不可渲染时由 canRender 在导航处给出结构化失败。
      const missing = routes
        .filter((route) => !router.hasRoute(route.name))
        .map((route) => route.name)
      if (!missing.length) return
      console.warn(
        `[wc-runtime-vue] 宿主 router 目前未注册这些页面（页面目录里声明的 name）：${missing.join('、')}。` +
          '常见原因：尚未登录 / 当前账号无权限 / manifest 的 name 与宿主 route 的 name 不一致。' +
          'agent 导航到它们时会拿到结构化失败，不会静默 404。',
      )
    },

    canRender(route: RuntimeRoute): string | null {
      if (router.hasRoute(route.name)) return null
      return (
        `宿主 router 未注册路由「${route.name}」（页面 ${route.tag}）：` +
        '可能尚未登录 / 当前账号无权限 / manifest 的 name 与宿主 route 的 name 不一致'
      )
    },

    async apply(view: RuntimeView): Promise<void> {
      // 出向路由推进由 createRouterBridge(...).apply 完成（与 container 同一条路径 + 同一套防回环机制）；
      // 这里只处理「真实 router 承载不了的东西」：直传 props 的响应式旁路。
      syncPageProps(view.props)
    },

    getPageExposed(tag) {
      const target = tag ?? currentTag()
      if (!target) return null
      return readExposed(target)
    },

    snapshot() {
      const loaded = router.currentRoute.value
      const name = loaded?.name == null ? null : String(loaded.name)
      if (!name) return null
      // 当前路由不在页面目录内（如登录页 / 404 页）→ 不纳入内核
      const routes = runtimeApi?.routes() ?? []
      if (!routes.some((route) => route.name === name)) return null
      return {
        name,
        path: loaded.fullPath,
        params: { ...loaded.params } as Record<string, unknown>,
        query: { ...loaded.query } as Record<string, string | string[]>,
        source: 'initial',
      }
    },

    history: {
      // 真实 URL 是最终裁决：vue-router 把 position / back / forward 写进 history.state
      get canGoBack() {
        const state = readHistoryState()
        if (!state) return false
        if (typeof state.position === 'number') return state.position > 0
        return state.back != null
      },
      get canGoForward() {
        return Boolean(readHistoryState()?.forward)
      },
      go(delta) {
        router.go(delta)
      },
    },

    createRouterBridge(api) {
      sync?.dispose()
      sync = createRouterSync(router, api, {
        // 宿主路由表是真相：绝不 addRoute
        registerRoutes: false,
        // 宿主自己的、目录外的路由（登录 / 404 / 宿主演示页）不归内核管：放行且不回流 ——
        // 否则 runtime 存活期间宿主的这些导航会被内核守卫挡掉（真实 URL 才是最终裁决）
        passThroughUnknownRoutes: true,
        // 真实 router 上的导航都是「用户在操作宿主界面」（agent 那一跳由 render 之后的 apply 触发，
        // 被 applying 计数器挡住不会回流）→ source 标记 host
        commitSource: 'host',
        apply: (location, replace) => pushIfChanged(location, replace),
        onNavigated: (to) => {
          // 页面组件挂载（含异步组件）通常在下一 tick 之后 → 挂载后补广播 expose
          // 注意：真实 router 给的是 route name，内核广播要的是 tag
          const name = to.name == null ? null : String(to.name)
          if (!name) return
          const tag = tagForName(name)
          if (tag) void nextTick(() => rebroadcastIfChanged(tag))
        },
      })
      return sync
    },

    dispose() {
      sync?.dispose()
      sync = null
      runtimeApi = null
      lastExposedKeys = ''
    },
  }
}
