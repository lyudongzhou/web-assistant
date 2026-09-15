# @webassistant/wc-runtime-vue

## 0.3.0

### Minor Changes

- 7e86e8d: 新增「用法 B：宿主直连」—— agent 直接操作宿主自己的 vue-router，页面在宿主自己的 `<router-view>` 渲染（不编译 WC、不建容器、不做样式隔离）。

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

### Patch Changes

- Updated dependencies [7e86e8d]
  - @webassistant/wc-runtime-core@0.2.0
  - @webassistant/protocol@0.1.1

## 0.2.0

### Minor Changes

- 113da5b: feat(store): 宿主 store → CE 的快照桥（镜像），页面零改动

  宿主 pinia 与批次 pinia 是**两个实例、两份库副本**（连 vue 都是两份），跨副本共享实例的
  响应式依赖收集不互通（页面会「首次能读、之后不更新」）。新增官方通道把宿主 store 的数据
  镜像进页面：

  - `createHostStorePusher({ getRuntime, only? })`（宿主侧，零 vue 依赖，挂在 `@webassistant/wc-runtime-vue/host`）：
    用 pinia 插件自动覆盖所有 store —— 创建即推一次、`$subscribe` 变更即推 `store:<id>` 快照；
    没有宿主 app 时可用 `pusher.push(store)` 手动桥。
  - `createStoreMirror({ only?, twoWay? })`（CE 侧）：容器 `plugins: [createPinia().use(mirror.plugin)]`
    - `setup(ctx) { mirror.attach(ctx) }`，按 store id 把快照 hydrate 进批次同名 store 并持续同步。
  - 附带 `cloneHostState` / `hostStoreKey` / `isHostStoreKey` / `hostStoreIdFromKey` /
    `STORE_PATCH_EVENT` / `applyHostStorePatch`（twoWay 回传用）。
  - 只同步可序列化 `$state`（getter/action/对象身份不过桥）；默认单向（宿主为真相源）。

  chat-client：为上述桥补上宿主侧的 runtime 句柄 —— `useRuntimeHost`/`useWebAssistant` 返回
  `runtime`（框架无关 API：`setState` / `setServices` / `getPageExposed`），`<WebAssistant>` 新增
  `onRuntimeReady` 回调，`mountWebAssistant` 新增 `{ plugins }`（挂载前安装宿主自己的 pinia/插件）。

## 0.1.0

### Minor Changes

- 2de5540: 新增「样式落点桥」（`styleShim`）：把指定包往 `document` 注入的样式镜像进容器 shadow root。

  **背景**：CSS-in-JS / UI 依赖在运行时 `document.head.appendChild(<style>)`；业务 WC 渲染在容器
  shadow root 内，document 树里的样式表匹配不到 shadow 树里的节点 → 样式在 WC 里不生效。

  - **`wc-runtime-core`**：新增 `styleSink.ts` ——
    目标注册表（`addStyleTarget` / `removeStyleTarget` / `currentStyleTargets`，状态挂
    `globalThis` + `Symbol.for`，跨 bundle 唯一）、`bindProxy`（解决 DOM 品牌校验的透传代理工厂）、
    `shadowDocument(realDoc)`（把 `<style>` / `<link rel=stylesheet>` 的插入镜像进注册表里的
    shadow root，含「空 style + `insertRule`」路径）、`installStyleSink()`。
    新增子路径导出 `@webassistant/wc-runtime-core/styleSink`。
  - **`wc-runtime-vue`**：容器 `mountContainer` 把自身 shadow root 登记为样式收件人，
    `unmountContainer` / `dispose` 注销（无登记时桥完全不起作用）。
  - **`vite-plugin-wc`**：新增 `wcBuildPlugin({ styleShim: { packages: [...] } })` ——
    给指定包模块前置 `var document = …shadowDocument(globalThis.document)`（模块级 transform，
    靠 Rollup 的 deconflict 把遮蔽范围收敛在被指定包内）+ 一个 `virtual:webassistant/style-sink`
    prelude 保证工厂先于被遮蔽模块求值。新增了对 `@webassistant/wc-runtime-core` 的依赖。
  - **demo-app**（不走 changeset）：新增 `src/vendor/fakeCssInJs.ts` 验收探针，覆盖 P1
    （`appendChild` + `textContent`）与 P2（空 `<style>` + `insertRule`）两条注入路径。

  **第二轮补齐**（由 `3d-force-graph` 真实依赖验收暴露）：

  - 支持「**先挂空 `<style>`、再填内容**」的注入写法：拦截后在该 style 实例上挂钩
    `appendChild / append / textContent`，内容填上时同步进镜像（`sheet.insertRule` 已有）。
    之前只覆盖 emotion/styled-components 的 `insertRule`，会镜像到空壳。
  - 修掉一个去重 bug：**多个包同时「空着插入」**时内容哈希相同 → 互相判重、只留第一条。
    空内容改用节点独立 key（`style:empty#N`）。这是 `3d-force-graph` + `three-render-objects`
    - `float-tooltip` 三个包同时注入时才暴露出来的。
  - `vite-plugin-wc` 的包匹配补充说明：CSS-in-JS 常散在子依赖里，需逐包列入；
    构建后可核对产物中 `document.head || …getElementsByTagName("head")` 的未改写残留是否为 0。

  **已知缺口**（有意不覆盖）：`window.document` / `globalThis.document` 等全局属性路径、未列入 `packages` 的子依赖、`const doc = document` 逃逸出被遮蔽模块、`insertAdjacentHTML`。

### Patch Changes

- Updated dependencies [31df00c]
- Updated dependencies [2de5540]
- Updated dependencies [2de5540]
- Updated dependencies [31df00c]
  - @webassistant/protocol@0.1.0
  - @webassistant/wc-runtime-core@0.1.0
