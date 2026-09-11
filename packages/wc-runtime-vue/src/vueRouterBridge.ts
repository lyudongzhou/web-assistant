// vue-router 桥：让页面里的 useRouter().push() 驱动 runtime 切换 WC。
//
// 三个必备机制：
// 1. 路由表同步：core 的 routes → addRoute（组件是哑组件，真正的渲染由容器按 tag 负责，不走 router-view）
// 2. guard 前移：core 的 beforeEach 判定挂到 vue-router 的 beforeEach，页面能拿到 NavigationFailure
// 3. 防回环：applying 计数器（不是布尔值 —— vue-router 导航是异步的，并发会把布尔 flag 打穿）
import {
  createMemoryHistory,
  createRouter,
  type RouteLocationNormalized,
  type RouteRecordRaw,
  type Router,
} from 'vue-router'
import type {
  NavigationTarget,
  RouterBridge,
  RouterBridgeApi,
  RuntimeLocation,
  RuntimeRoute,
} from '@webassistant/wc-runtime-core'

const DummyPage = { render: () => null }

export function toRouteRecords(routes: readonly RuntimeRoute[]): RouteRecordRaw[] {
  return routes.map((route) => ({
    name: route.name,
    path: route.path,
    component: DummyPage,
    meta: { ...route.meta, tag: route.tag, title: route.title, framework: route.framework },
  }))
}

export function createVueRouter(routes: readonly RuntimeRoute[] = []): Router {
  return createRouter({ history: createMemoryHistory(), routes: toRouteRecords(routes) })
}

function toTarget(to: RouteLocationNormalized): NavigationTarget {
  return {
    name: to.name == null ? undefined : String(to.name),
    path: to.name == null ? to.fullPath : undefined,
    params: { ...to.params } as Record<string, unknown>,
    query: { ...to.query } as Record<string, string | string[]>,
    source: 'page',
  }
}

export interface VueRouterBridge extends RouterBridge {
  readonly router: Router
}

export function createVueRouterBridge(router: Router, api: RouterBridgeApi): VueRouterBridge {
  let applying = 0
  let known = new Set<string>()

  function syncRoutes(routes: readonly RuntimeRoute[]): void {
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
    const checked = api.canNavigate(toTarget(to))
    return checked.ok ? true : false
  })

  const offAfter = router.afterEach((to, _from, failure) => {
    if (failure) return
    if (applying > 0) return // ★ 防回环：这一跳是 core 推过来的，不要再 commit 回去
    void api.commit(toTarget(to))
  })

  return {
    router,
    apply(location: RuntimeLocation, replace: boolean) {
      applying += 1
      const target = {
        name: location.name,
        params: location.params as never,
        query: location.query as never,
      }
      const task = replace ? router.replace(target) : router.push(target)
      return task
        .catch(() => undefined)
        .then(() => undefined)
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
