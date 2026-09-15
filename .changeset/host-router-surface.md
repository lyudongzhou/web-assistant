---
'@webassistant/wc-runtime-core': minor
'@webassistant/wc-runtime-vue': minor
'@webassistant/chat-client': minor
'@webassistant/protocol': patch
'@webassistant/analyzer': patch
'@webassistant/vite-plugin-wc': patch
---

新增「用法 B：宿主直连」—— agent 直接操作宿主自己的 vue-router，页面在宿主自己的 `<router-view>` 渲染（不编译 WC、不建容器、不做样式隔离）。

- **wc-runtime-core**：把 runtime 拆成「内核（kernel.ts）+ 渲染面（PageSurface / RuntimeHistory 两个扩展点）」，
  `createRuntime({ surface: 'container' | 'host' })` 选择渲染面；默认 container **行为与解耦前等价**（既有单测断言零改动）。
  容器实现迁入 `surfaceContainer.ts`；manifest 归一化支持宿主批次（`bundle` 可省、`containers` 可空、`tag` 无需含 `-`）；
  新增 `surface` / `hostSurface` / `adopt` 选项，`init(root?)` 允许不传挂载点；`RuntimeHistory` 支持外部历史（委托宿主）。
- **wc-runtime-vue**：抽出 `routerSync.ts`（guard 前移 / `applying` 防回环 / 回流 commit，两种用法共用一份）；
  新增 `createVueHostSurface()` 与 `createVueHostRuntime()` 及子入口 `@webassistant/wc-runtime-vue/host-router`；
  `RuntimeServicesContext` 新增 `pageProps` 旁路（container 模式恒为空）。
- **chat-client**：新增 `surface` / `createRuntime` 注入口与 host 模式面板（无渲染区，只显示状态）；
  `useRuntimeHost` 允许无挂载点初始化；单实例约束告警。
- **protocol / analyzer / vite-plugin-wc**：`wc.pages.json` 的 `container` 变为可选 —— 省略即宿主直连批次，
  analyzer / `wcManifestPlugin` 不再写 `containers` 与 `pages[].bundle`（WC 构建侧仍强制要求 container）；
  `ManifestPage.bundle` 变可选。
- **demo-app**：新增 `host.html` + `src/host-main.ts` 验收台与 `pnpm dev:host` / `pnpm analyze:host` 脚本。
