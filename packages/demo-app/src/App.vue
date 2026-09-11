<template>
  <div class="app">
    <nav class="nav">
      <router-link to="/users">用户列表</router-link>
      <router-link to="/dashboard">数据看板</router-link>
      <router-link to="/orders">订单管理</router-link>
    </nav>
    <router-view />
  </div>
</template>

<style scoped>
.app {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
  font-family: system-ui, sans-serif;
}
.nav {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}
.nav a {
  color: #3b82f6;
  text-decoration: none;
}
.nav a.router-link-active {
  font-weight: 600;
}
</style>
