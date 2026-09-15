---
'@webassistant/wc-runtime-vue': minor
'@webassistant/chat-client': minor
---

feat(store): 宿主 store → CE 的快照桥（镜像），页面零改动

宿主 pinia 与批次 pinia 是**两个实例、两份库副本**（连 vue 都是两份），跨副本共享实例的
响应式依赖收集不互通（页面会「首次能读、之后不更新」）。新增官方通道把宿主 store 的数据
镜像进页面：

- `createHostStorePusher({ getRuntime, only? })`（宿主侧，零 vue 依赖，挂在 `@webassistant/wc-runtime-vue/host`）：
  用 pinia 插件自动覆盖所有 store —— 创建即推一次、`$subscribe` 变更即推 `store:<id>` 快照；
  没有宿主 app 时可用 `pusher.push(store)` 手动桥。
- `createStoreMirror({ only?, twoWay? })`（CE 侧）：容器 `plugins: [createPinia().use(mirror.plugin)]`
  + `setup(ctx) { mirror.attach(ctx) }`，按 store id 把快照 hydrate 进批次同名 store 并持续同步。
- 附带 `cloneHostState` / `hostStoreKey` / `isHostStoreKey` / `hostStoreIdFromKey` /
  `STORE_PATCH_EVENT` / `applyHostStorePatch`（twoWay 回传用）。
- 只同步可序列化 `$state`（getter/action/对象身份不过桥）；默认单向（宿主为真相源）。

chat-client：为上述桥补上宿主侧的 runtime 句柄 —— `useRuntimeHost`/`useWebAssistant` 返回
`runtime`（框架无关 API：`setState` / `setServices` / `getPageExposed`），`<WebAssistant>` 新增
`onRuntimeReady` 回调，`mountWebAssistant` 新增 `{ plugins }`（挂载前安装宿主自己的 pinia/插件）。
