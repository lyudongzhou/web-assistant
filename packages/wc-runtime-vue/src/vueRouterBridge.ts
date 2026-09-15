// vue-router 桥（container 用法）：让页面里的 useRouter().push() 驱动 runtime 切换 WC。
//
// 三机制（guard 前移 / 路由表同步 / applying 防回环）已抽到 routerSync.ts，与宿主直连用法共用一份；
// 这里只是「用 memory router + 注册哑组件」的那层薄封装，导出签名保持不变。
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { RouterBridgeApi, RuntimeRoute } from '@webassistant/wc-runtime-core'
import { createRouterSync, toNavigationTarget, toRouteRecords, type VueRouterSync } from './routerSync.js'

export { toNavigationTarget, toRouteRecords }

export function createVueRouter(routes: readonly RuntimeRoute[] = []): Router {
  return createRouter({ history: createMemoryHistory(), routes: toRouteRecords(routes) })
}

export interface VueRouterBridge extends VueRouterSync {}

export function createVueRouterBridge(router: Router, api: RouterBridgeApi): VueRouterBridge {
  return createRouterSync(router, api, { registerRoutes: true })
}
