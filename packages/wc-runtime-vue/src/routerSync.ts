// 框架 router 同步：core ↔ 框架 router 的三个必备机制 —— container 与宿主两种用法**共用这一份**。
//
// 1. guard 前移：core 的 beforeEach 判定挂到框架 router 的 beforeEach → 页面能拿到 NavigationFailure，
//    不再出现「router 成功、core 拒绝」的分裂状态
// 2. 路由表同步：core routes → addRoute（**仅 container 用**；宿主模式真实路由表已存在 → registerRoutes: false）
// 3. 防回环：applying 计数器（不是布尔值 —— vue-router 导航是异步的，并发会把布尔 flag 打穿）
import { type RouteLocationNormalized, type RouteRecordRaw, type Router } from 'vue-router'
import type {
  NavigationSource,
  NavigationTarget,
  RouterBridge,
  RouterBridgeApi,
  RuntimeLocation,
  RuntimeRoute,
} from '@webassistant/wc-runtime-core'

/** 哑组件：container 模式下真正的渲染由容器按 tag 负责，**不走 `<router-view>`** */
const DummyPage = { render: () => null }

export function toRouteRecords(routes: readonly RuntimeRoute[]): RouteRecordRaw[] {
  return routes.map((route) => ({
    name: route.name,
    path: route.path,
    component: DummyPage,
    meta: { ...route.meta, tag: route.tag, title: route.title, framework: route.framework },
  }))
}

/** vue-router 的 RouteLocation → 框架无关的 NavigationTarget */
export function toNavigationTarget(
  to: RouteLocationNormalized,
  source: NavigationSource = 'page',
): NavigationTarget {
  return {
    name: to.name == null ? undefined : String(to.name),
    path: to.name == null ? to.fullPath : undefined,
    params: { ...to.params } as Record<string, unknown>,
    query: { ...to.query } as Record<string, string | string[]>,
    source,
  }
}

/** 默认出向实现：core 的 location → `router.push/replace` */
export function defaultApplyLocation(router: Router) {
  return (location: RuntimeLocation, replace: boolean): void | Promise<void> => {
    const target = {
      name: location.name,
      params: location.params as never,
      query: location.query as never,
    }
    const task = replace ? router.replace(target) : router.push(target)
    return task.catch(() => undefined).then(() => undefined)
  }
}

export interface RouterSyncOptions {
  /**
   * 是否把 core 路由表 register 进框架 router：
   * - container：true（哑组件；`push({ name })` 要求 name 存在）
   * - host：false（宿主路由表是真相，**绝不 addRoute**）
   */
  registerRoutes: boolean
  /** 出向：core 导航 → 框架 router。缺省用 defaultApplyLocation（host 模式可换成「同路由跳过」的版本） */
  apply?: (location: RuntimeLocation, replace: boolean) => void | Promise<void>
  /**
   * 框架 router 回流内核时标记的 `source`：
   * - container：'page'（那是页面内的 memory router —— 页面代码在导航）
   * - host：'host'（那是宿主的真实 router —— 用户在导航）
   */
  commitSource?: NavigationSource
  /** 每次框架 router 完成一次导航后的回调（host 模式用来在页面挂载后补广播 expose） */
  onNavigated?: (to: RouteLocationNormalized) => void
}

export interface VueRouterSync extends RouterBridge {
  readonly router: Router
}

/**
 * 给一个框架 router 装上三机制。`applying` 计数器保证「core 推给 router」的那一跳不会被回流。
 */
export function createRouterSync(
  router: Router,
  api: RouterBridgeApi,
  options: RouterSyncOptions,
): VueRouterSync {
  let applying = 0
  let known = new Set<string>()
  const applyLocation = options.apply ?? defaultApplyLocation(router)
  const source = options.commitSource ?? 'page'

  function syncRoutes(routes: readonly RuntimeRoute[]): void {
    if (!options.registerRoutes) return
    const next = new Set(routes.map((route) => route.name))
    for (const name of known) {
      if (!next.has(name) && router.hasRoute(name)) router.removeRoute(name)
    }
    for (const record of toRouteRecords(routes)) {
      if (!router.hasRoute(record.name!)) router.addRoute(record)
    }
    known = next
  }

  syncRoutes(api.routes)

  const offBefore = router.beforeEach((to) => {
    // core 推过来的导航：core 已判定过，直接放行
    if (applying > 0) return true
    const checked = api.canNavigate(toNavigationTarget(to, source))
    return checked.ok ? true : false
  })

  const offAfter = router.afterEach((to, _from, failure) => {
    options.onNavigated?.(to)
    if (failure) return
    if (applying > 0) return // ★ 防回环：这一跳是 core 推过来的，不要再 commit 回去
    void api.commit(toNavigationTarget(to, source))
  })

  return {
    router,
    apply(location, replace) {
      applying += 1
      return Promise.resolve(applyLocation(location, replace))
        .catch(() => undefined)
        .finally(() => {
          applying -= 1
        })
    },
    setRoutes(routes) {
      syncRoutes(routes)
    },
    dispose() {
      offBefore()
      offAfter()
    },
  }
}
