# @webassistant/wc-runtime-vue

## 0.5.0

### Minor Changes

- 一份清单驱动两条渲染面：host 面复用容器形状的 manifest，`/wc-ce` 前缀退场

  - **`wc-runtime-core`**：`normalizeManifest` 在宿主渲染面（`forHostSurface`）下把 WC 专属资产**归一化为空**
    （`pages[].bundle === ''`、`containers` / `sharedStyles` 为空数组）。此前只「放宽必填」、不清理多余字段，
    于是喂进容器形状 manifest 时 `bundle` 会留下 `joinUrl(undefined,'pages/x.js')='pages/x.js'` 这样的相对路径残留，
    与 `RuntimeRoute.bundle` 注释承诺的「宿主面恒为空串」不符。现在容器面与宿主面可以**共用同一份 manifest**。
  - **`wc-runtime-vue`**：新增 `createVueHostRuntimeBinding({ router, app, services })` → `{ createRuntime }`，
    把宿主直连 runtime 与 chat-client 的注入口对齐（收敛 `base → manifestUrl` 与 `initial` 转发，
    这两处手写最容易出错且**错了不报错**）；导出 `resolveHostManifestUrl` / `DEFAULT_MANIFEST_BASE`。
  - **`analyzer`**：清单声明了 `container` 时，对不含 `-` 的 `tag` 提前警告 —— 同一份清单现在也驱动 WC 构建
    （`loadWcPages` 要求合法自定义元素名），否则要到 `build:ce` 才在构建期报错、离清单很远。
  - **demo-app / 文档**：删除 `wc.host.json` 与 `analyze:host`；唯一 manifest 落 `public/wc/manifest.json`；
    容器批次产物 URL 由 `/wc-ce/dist-ce/**` 收敛为 `/wc/dist-ce/**`（`wcBase` 两条链路都是 `/wc`）；
    agent-server 默认 manifest 路径同步改到 `public/wc/manifest.json`。
    规则文档里 `/lab`「agent 不可导航」的说法同步修正（一份清单下所有页面都在目录内）。
  - 行为等价性由单测锁定：`wc-runtime-core` 新增「容器形状 manifest 走宿主归一化后，页面目录逐字段等价」。

### Patch Changes

- 宿主直连（用法 B）两处修复；chat-client 收窄为纯组件库（演示统一到 demo-app）

  - `wc-runtime-vue`：host 模式下**不再拦住宿主自己的路由**。内核守卫此前对宿主的任何导航都调用
    `canNavigate`，而内核只认页面目录 → runtime 存活期间点不进登录页 / 404 / 宿主演示页
    （vue-router 以 NavigationFailure resolve，没有任何报错，表现为「点了没反应」）。
    新增桥选项 `passThroughUnknownRoutes`（host 恒开）：目录外的路由放行且不回流内核；
    容器模式缺省 false，行为逐字节不变。
  - `chat-client`：`debug` 的 `globalThis.__waRuntime` 句柄在卸载时改为「只在当前挂着的还是本实例」
    才删除 —— 同页第二个 runtime（例如 WC 演示页 + 宿主 dock）不会再把仍在运行的实例句柄抹掉。
    同时移除库内自带的 SPA demo（`index.html` / `src/main.ts` / `src/style.css` / `vite.config.ts`
    与 `dev` / `preview` / `build` 脚本）：库只管组件，演示统一在 demo-app 里做。

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @webassistant/protocol@0.3.0
  - @webassistant/wc-runtime-core@0.3.2

## 0.4.0

### Minor Changes

- 258d331: refactor(observe)!: 退役自动网络观测 —— 数据只由调用点显式 `apiBus.report` 上报

  **破坏性变更**

  - 删除 `NetworkObserver`（不再包装 `window.fetch` / `XMLHttpRequest`）与 `CreateRuntimeOptions.observeNetwork`；
    随之删除各类型/句柄上的 `observer` 字段、`network-observation` 事件、`WcActivityKind` 的 `'network'`。
  - 协议删除 `page.network.request|response|error|timeout` 四条客户端消息与 `PageNetwork*` 类型、
    `AgentSession.pendingRequests`；`ObservationMatch` 由 `requestId/method/url` 改为 `source/event/contains`。
  - chat-client 删除 `onNetworkObservation` / `sendObservation`。
  - **数据上报只有一条路**：调用方（宿主 / 页面）在需要的调用点显式 `apiBus.report({ source, data })`；
    **不调 = 零数据出浏览器**（天然 fail-closed，无需维护白名单）。

  **原因**：全量拦截宿主页面的请求（真实站点往往有大量内部接口）会把不相关甚至敏感的数据带出浏览器，
  而靠事后白名单 / 脱敏补救既不可靠（fetch 分支曾漏检黑名单）、也难以维护；同时改写全局 fetch 还带来
  阻塞流式响应、多实例抢占、`stop()` 后残留包装等副作用。

  **其他改动**

  - `apiBus.report()`：`url` 改可选、新增 `source`；返回 `boolean`（false = 当前无人监听）。
  - `apiBus.attach()` 增加**覆盖告警**（单 sink 语义）：业务侧误调 `attach()` 顶掉内核 sink 时立刻可见。
  - **chat-client 转出 `apiBus` / `ApiReport`**：只装面板的宿主（用法 A）不必为了上报再引一个包。
  - `sanitizeData` 从 `observer.ts` 搬到 `sanitize.ts`，并修掉 O(n²) 的体积统计（现为线性、上限更可预期）。
  - runtime 侧对上报数据只做：补 `page`/`at` + 体积/深度硬上限（16KB / 深度 4）+ **可选**的
    `dataSources` 裁剪（命中才裁；未命中即原样透传）。
  - `wait_for_observation` 工具描述与匹配条件改为「等待显式上报的数据 / 页面事件」。

  **迁移**：把原来的自动上报（如 axios 拦截器里统一 `apiBus.report`）改为在**明确的调用点**上报，
  并只传你愿意公开的字段；页面/宿主未调用则 agent 侧不会收到任何业务数据。

### Patch Changes

- Updated dependencies [258d331]
  - @webassistant/wc-runtime-core@0.3.0
  - @webassistant/protocol@0.2.0

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
