// 宿主路由表 + 宿主自己的守卫。
//
// 与 manifest（wc.pages.json → public/wc/manifest.json）的关系 —— **契约**：
//   路由的 `name` 必须与 manifest 页面的 `name` 逐字相同（host 模式的硬约束，见 PROJECT.md 6.9）。
//   agent 只能导航到 manifest 里的页面；本表里**不在 manifest** 的路由（/login、/assistant）
//   由桥的 passThrough 放行，且不会回流内核（agent 也就看不到它们）。
//   注：/lab 在清单里（能力验收室可被 agent 打开演示 runtime 能力），因此它走目录内路径，不是 passThrough。
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/authStore'

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  // —— 不在 manifest：宿主自己的路由（登录 / 验收室 / 容器演示）——
  {
    path: '/login',
    name: 'Login',
    component: () => import('../pages/Login.vue'),
    meta: { title: '登录' },
  },
  {
    path: '/lab',
    name: 'Lab',
    component: () => import('../pages/Lab.vue'),
    meta: { title: '能力验收室' },
  },
  {
    path: '/assistant',
    name: 'AssistantWc',
    component: () => import('../pages/AssistantWc.vue'),
    // waSurface: 'container' → App.vue 据此隐藏 host dock（一页只允许一个 runtime）
    meta: { title: '助手（容器模式）', waSurface: 'container' },
  },
  // —— 在 manifest：agent 可导航的业务页面 ——
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('../pages/Dashboard.vue'),
    meta: { title: '工作台' },
  },
  {
    path: '/users',
    name: 'UserList',
    component: () => import('../pages/UserList.vue'),
    meta: { title: '用户管理' },
  },
  {
    path: '/users/:id',
    name: 'UserDetail',
    component: () => import('../pages/UserDetail.vue'),
    meta: { title: '用户详情' },
  },
  {
    path: '/orders',
    name: 'OrderList',
    component: () => import('../pages/OrderList.vue'),
    meta: { title: '订单管理' },
  },
  {
    path: '/datasources',
    name: 'DatasourceAdmin',
    component: () => import('../pages/DatasourceAdmin.vue'),
    meta: { title: '数据源管理' },
  },
  {
    path: '/query-params',
    name: 'QueryParamsDemo',
    component: () => import('../pages/QueryParamsDemo.vue'),
    meta: { title: '查询参数示例' },
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../pages/Settings.vue'),
    // 站点设置需要登录 → 演示「宿主自己的守卫」：agent 的导航同样会被拦下来
    //（已知缺口：被拒时 URL 没变，但 agent 侧仍收到 ok:true，见 PROJECT.md 6.9）
    meta: { title: '站点设置', requiresAuth: true },
  }
]

export const router = createRouter({ history: createWebHashHistory(), routes })

router.beforeEach((to) => {
  if (!to.meta.requiresAuth) return true
  // 在守卫里现取 store（模块顶层取会早于 pinia 安装）
  const auth = useAuthStore()
  if (auth.token) return true
  return { name: 'Login', query: { redirect: to.fullPath } }
})

export default router

