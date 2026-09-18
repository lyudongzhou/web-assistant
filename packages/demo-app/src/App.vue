<script setup lang="ts">
// demo-app 的**唯一宿主外壳**：左侧导航 + 内容区（<router-view>）+ 用法 B 的悬浮助手。
//
// ★ 为什么 dock 必须挂在 <router-view> 之外（AppShell 之外）：agent 的导航会落到宿主**真实 router**，
//   面板若挂在路由组件里，agent 一导航面板自身就被卸载、对话中断（docs/INTEGRATION_GUIDE.md「五条硬规矩」第 1 条）。
// ★ /assistant（容器模式演示页）里隐藏 dock：同一页只允许一个 runtime
//   （apiBus / activityBus 是全局单例，两个 runtime 会互相抢占上报）。
import { computed } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import AppShell from "./layout/AppShell.vue";
import AssistantDock from "./components/AssistantDock.vue";

const route = useRoute();
/** 当前路由是「容器模式演示页」（meta.waSurface === 'container'）→ 不挂 host dock */
const showHostDock = computed(() => route.meta.waSurface !== "container");
const router = useRouter();
(window as unknown as { router: unknown }).router = router;
</script>

<template>
  <AppShell>
    <RouterView />
  </AppShell>

  <!-- 用法 B 的助手面板：悬浮层，不随路由切换消失（见组件内注释） -->
  <AssistantDock v-if="showHostDock" />
</template>
