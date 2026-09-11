// SPA 模式的路由表（`pnpm dev` 用，只为验证页面功能）。
// WC 模式的路由由 wc.pages.json → manifest → runtime 驱动，与这里无关。
import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router";

export const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/users" },
  {
    path: "/users",
    name: "UserList",
    component: () => import("../pages/UserList.vue"),
    meta: { title: "用户列表" },
  },
  {
    path: "/users/:id",
    name: "UserDetail",
    component: () => import("../pages/UserDetail.vue"),
    meta: { title: "用户详情" },
  },
  {
    path: "/dashboard",
    name: "Dashboard",
    component: () => import("../pages/AppDashboard.vue"),
    meta: { title: "数据看板" },
  },
  {
    path: "/orders",
    name: "OrderList",
    component: () => import("../pages/OrderList.vue"),
    meta: { title: "订单管理" },
  },
  {
    path: "/products",
    name: "ProductList",
    component: () => import("../pages/ProductList.vue"),
    meta: { title: "商品管理" },
  },
  {
    path: "/datasource",
    name: "DatasourceAdmin",
    component: () => import("../pages/DatasourceAdmin.vue"),
    meta: { title: "数据源管理" },
  },
];

export const router = createRouter({ history: createWebHashHistory(), routes });

export default router;
