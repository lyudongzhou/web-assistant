<script setup lang="ts">
// 应用外壳：左侧导航 + 顶栏 + 内容区。
//
// 演示应用里它承担两件事：
//   1. 把「业务页面」与「演示页面」分开（验收室 / 容器演示归到「演示」分组）
//   2. 顶栏的登录态 = **宿主自己的** store —— 与助手无关，页面照常用 useAuthStore()
//      （token 经 services.getToken 进请求头，见 src/ce/container.ts 与 utils/httpClient.ts 的注释）
import { computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/authStore'

interface NavItem {
  name: string
  label: string
}

const businessNav: NavItem[] = [
  { name: 'Dashboard', label: '工作台' },
  { name: 'UserList', label: '用户管理' },
  { name: 'OrderList', label: '订单管理' },
  { name: 'DatasourceAdmin', label: '数据源管理' },
  { name: 'Settings', label: '站点设置' },
]

const demoNav: NavItem[] = [
  { name: 'Lab', label: '能力验收室' },
  { name: 'AssistantWc', label: '助手（容器模式）' },
]

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

/** 当前页是否命中该导航（用 route.name 比对，避免 :id 子路由把父项点亮） */
const isActive = (name: string): boolean => route.name === name

const userLabel = computed(() =>
  auth.user ? `${auth.user.name} · ${auth.user.role}` : '未登录',
)

function logout(): void {
  auth.logout()
  void router.push({ name: 'Login' })
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">WA</span>
        <span class="brand-text">WebAssistant 演示后台</span>
      </div>
      <nav class="nav">
        <p class="nav-group">业务页面</p>
        <RouterLink
          v-for="item in businessNav"
          :key="item.name"
          class="nav-item"
          :class="{ active: isActive(item.name) }"
          :to="{ name: item.name }"
        >
          {{ item.label }}
        </RouterLink>
        <p class="nav-group">演示</p>
        <RouterLink
          v-for="item in demoNav"
          :key="item.name"
          class="nav-item"
          :class="{ active: isActive(item.name) }"
          :to="{ name: item.name }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="topbar-left">
          <span class="tag">演示环境</span>
          <span class="muted">数据来自本地 mock 后端（:8080）</span>
        </div>
        <div class="topbar-right">
          <span class="user">{{ userLabel }}</span>
          <el-button v-if="auth.user" size="small" @click="logout">退出登录</el-button>
          <RouterLink v-else :to="{ name: 'Login' }">
            <el-button size="small" type="primary">去登录</el-button>
          </RouterLink>
        </div>
      </header>

      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}
.sidebar {
  width: var(--app-sidebar-width);
  flex: 0 0 var(--app-sidebar-width);
  background: var(--app-surface);
  border-right: 1px solid var(--app-border);
  padding: var(--app-space-4) var(--app-space-3);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--app-space-2);
  padding: 0 var(--app-space-2) var(--app-space-4);
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--app-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.brand-text {
  font-size: 13px;
  font-weight: 600;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-group {
  margin: var(--app-space-3) var(--app-space-2) var(--app-space-2);
  font-size: 11px;
  color: var(--app-text-muted);
  letter-spacing: 0.04em;
}
.nav-item {
  padding: 8px var(--app-space-3);
  border-radius: var(--app-radius-sm);
  color: var(--app-text-secondary);
  font-size: 13px;
}
.nav-item:hover {
  background: var(--app-bg);
  color: var(--app-text);
}
.nav-item.active {
  background: var(--app-primary-weak);
  color: var(--app-primary);
  font-weight: 600;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.topbar {
  height: var(--app-topbar-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--app-space-3);
  padding: 0 var(--app-space-5);
  background: var(--app-surface);
  border-bottom: 1px solid var(--app-border);
}
.topbar-left,
.topbar-right {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
}
.tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--app-primary-weak);
  color: var(--app-primary);
  font-size: 11px;
}
.user {
  font-size: 13px;
  color: var(--app-text-secondary);
}
.muted {
  font-size: 12px;
  color: var(--app-text-muted);
}
.content {
  flex: 1;
  padding: var(--app-space-5);
  width: 100%;
}
</style>
