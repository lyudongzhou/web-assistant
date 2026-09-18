<script setup lang="ts">
// 用法 A（容器 / WC 模式）演示页 —— 挂在宿主自己的某个路由下。
//
// 与用法 B 的关键差别：container 模式的 agent 导航只动**面板内**的 memory router，
// **不改宿主 URL** → 所以面板可以安全地挂在路由组件里（不会被 agent 导航卸载）。
//
// 产物与清单（`public/wc/`）—— **与用法 B 共用同一份 manifest**：
//   {wcBase}/manifest.json  → 页面目录 + containers.vue + 页面 bundle（一份，两条链路都读）
//   {wcBase}/dist-ce/**     → 容器 + 页面 bundle（`pnpm build:ce` 产出；只有本模式需要）
//   命令：`pnpm analyze` + `pnpm build:ce`（或 build:ce:watch）
// 页面集合 = 清单全量（Dashboard / UserList / UserDetail / OrderList / DatasourceAdmin / Settings / Lab），
// 与用法 B 完全一致 —— 用来对照「同一页面在两条用法下的差异」（样式隔离、store 镜像、emit 捕获）。
import { WebAssistant } from "@webassistant/chat-client";
import { hostServices } from "../utils/hostServices";

// `?wa-debug` 可打开 debug（把 runtime 挂到 __waRuntime）
const debug = new URLSearchParams(window.location.search).has("wa-debug");
// 宿主能力注入：容器会把 services 透传给页面（useRuntimeServices()）
const services = hostServices();
</script>

<template>
  <section class="wc">
    <h2>用法 A：容器 / WC 模式</h2>
    <p class="hint">
      页面被编译成 Web Component，在<strong>面板内的渲染区</strong>渲染（shadow
      root 隔离）。 宿主 URL 不变；面板挂在本路由里也不会被 agent 导航卸载。
    </p>
    <p class="hint">
      manifest：<code>/wc/manifest.json</code> · 产物：<code>/wc/dist-ce/**</code>
      —— 先跑 <code>pnpm analyze</code> + <code>pnpm build:ce</code>（或
      <code>build:ce:watch</code>）。 与用法 B <strong>共用同一份 manifest</strong>（清单
      <code>wc.pages.json</code>，命令无需第二遍）。
    </p>
    <div class="panel-slot">
      <WebAssistant
        ws-base="/ws"
        :services="services"
        title="WebAssistant（容器 / WC 模式）"
        subtitle="页面在面板内渲染 —— 与宿主直连模式共用同一套 agent API 与清单"
        placeholder="试试：打开数据源管理"
        show-activity-log
        :debug="debug"
      />
    </div>
  </section>
</template>

<style scoped>
.wc {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.wc h2 {
  margin: 0 0 8px;
  font-size: 16px;
}
.hint {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-text-muted);
}
code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--app-bg);
}
.panel-slot {
  flex-grow:1;
  /* ★ `--wa-height: 100%` 必须给：组件根默认 `height: 100vh`，会溢出这个 ~680px 的槽位。
     `--wa-log-width` 收窄到 300px，三列（对话 / 渲染区 / 监视）才都不憋屈。 */
  height: min(680px, calc(100vh - 160px));
  margin-top: 12px;
  border-radius: var(--app-radius);
  overflow: hidden;
  border: 1px solid var(--app-border);
  background: var(--app-surface);
  --wa-height: 100%;
  --wa-log-width: 300px;
}
.panel-slot > * {
  height: 100%;
}
</style>
