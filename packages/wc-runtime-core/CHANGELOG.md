# @webassistant/wc-runtime-core

## 0.4.0

### Minor Changes

- 7c0d8b2: 路由入参通道显式化：path 之外还能声明 query 参数（页面写 `route.query.x` 也能被 agent 传参驱动）。

  - **`protocol`**：`ManifestParam` 新增 `in?: 'path' | 'query'`（缺省 `path`，**path 参数不写该字段** ⇒ 旧 manifest / 手写 manifest 完全兼容）与 `description`；
    `WcPageEntry` 新增 `query?: Array<Omit<ManifestParam, 'in'>>` 显式声明逃生口（**可选**；通道固定 query —— 动态键 / 模板不可见 / 想覆盖说明或类型）。
  - **`analyzer`**：新增 `src/routeScan.ts` —— 纯 AST 探测页面源码里的 `route.query.x` 读取
    （`useRoute()` 绑定名 / `{ query: q }` 别名 / `route.query['x']` / `const { x: alias } = route.query` / 内联 / 模板 `$route.query.x`），
    带类型推断（同名 props > 包装调用 > 兜底字面量 > 恒等比较 > `string`）与诊断（动态键 / 整块读 / `route.params.x` 与 path 不一致）；
    查询参数的 `description` 只取声明处注释的**第一行**（续行是开发者向说明，不出网进 prompt），诊断按通道指路
    （params 不一致 → 补 path 段位或改读 query），显式声明与 path 段同名时提示「会形成双通道两条入参」；
    `resolvePageParams()` 是 analyzer 与 `vite-plugin-wc` 共用的装配入口（顺手消掉两份重复的 `extractParams`）；
    `AiPageResult` 新增 `paramDescriptions`（AI 只给已探测到的参数补说明）。
  - **`wc-runtime-core`**：`resolve()` 按 `route.params[].in` 把 agent 的 `params` 分流到 `location.query`（值收口 `string` / `string[]`），
    未声明的键保持旧行为；`sameLocation()` 计入 query（query 变化 = 新导航，back 能回到上一个筛选条件）；
    `resolveProps()` 让声明过的 prop 从 `params ?? query` 取值，但不把未声明的 query 键写进 props（避免污染元素属性）。
  - **`vite-plugin-wc`**：manifest 生成改用 analyzer 的 `resolvePageParams`，两条构建路径不再各算一套。
  - **`chat-client` / `wc-runtime-vue`**：无需改动（`location.query` 早已被容器 memory router 桥与宿主真实 router 桥消费）。
  - **`agent-server`**（未发版）：prompt 参数按通道分段（`路径参数：` / `查询参数：`）+ 一条「两种通道都放进 `render` 的 params」规则句。

### Patch Changes

- Updated dependencies [7c0d8b2]
  - @webassistant/protocol@0.4.0

## 0.3.2

### Patch Changes

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

- Updated dependencies
- Updated dependencies
  - @webassistant/protocol@0.3.0

## 0.3.1

> 0.3.0 **本身是可用的**：`registry.npmjs.org` 的**边缘节点**（本机网络路径）取 tarball 返回 404，
> 但镜像（registry.npmmirror.com）能正常取回，实测 `npm i @webassistant/chat-client@0.5.0`
> 可解析并安装 0.3.0。因已发布的版本号无法撤回，改以 0.3.1 补发（内容与 0.3.0 完全相同），
> 并把 `latest` 指到 0.3.1，避免消费者踩到该边缘节点的陈旧缓存。

### Patch Changes

- 无代码变更（同 0.3.0，仅换版本号重发）。

## 0.3.0

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
  - @webassistant/protocol@0.2.0

## 0.2.0

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
  - @webassistant/protocol@0.1.1

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

- 2de5540: **styleShim 由「克隆」改为「改道」+ 页级 scope**

  - `shadowDocument` 代理不再「原节点留 head + clone 进 shadow」，而是命中的 `<style>` / `<link rel=stylesheet>`
    把**库自己的真节点**直接移进容器 shadow root：节点进了已连接的 shadow root 后自身 `sheet` 即生效，
    因此 `sheet.insertRule/deleteRule`、`appendChild(textNode)`、`textContent = css` 都直接作用在它自己身上 ——
    不再需要挂钩同步，也不再按内容哈希去重（旧实现里「多个包同时空着插入互相撞车」的问题随之消失）。
  - 样式归容器所有：`unmountContainer` / `dispose` 时随容器元素一起销毁，不再有「mirrors 表钉住游离
    shadow root」的泄漏。
  - 新增**页级 scope**：`beginStyleScope(tag)` / `endStyleScope()` 标记页面加载窗口，`activateStyleScope(tag)`
    在切页时把非当前页的节点从容器摘下（缓存）、切回再挂回（ESM 只求值一次，不能真销毁）；
    `clearStyleScopes()` 在 `runtime.dispose` 清空。未 `beginStyleScope` 的（容器级）注入归
    `DEFAULT_STYLE_SCOPE`，恒定挂着、不参与摘挂。
  - `runtime.ts`：`ensurePage` 用 `beginStyleScope(route.tag)` 包住页面 bundle 加载；`render()` 调
    `activateStyleScope(当前页 tag)`；`dispose()` 调 `clearStyleScopes()`。
  - 已知限制：改道固定投到 `targets[0]`（单容器假设）；库调用 `head.removeChild(改道节点)` 由代理兜底处理。

- 31df00c: **欢迎页 = 渲染区空态**（runtime 没有渲染子 WC 时渲染区的默认内容）：逻辑对外开放，宿主可整体覆盖。

  - **`wc-runtime-core`**：新增 `Runtime.hasPage`（有当前页 ⇔ 已渲染出子 WC，与 `RuntimeView.tag` 同源；
    `false` 时宿主应展示空态）。`initial: null` 不导航 → 天然 `false`，不再需要宿主自己记「导航过没有」。
  - **`chat-client`**：欢迎页拆三层并全部导出 ——
    - `lib/welcome.ts`（纯逻辑、零依赖、可单测）：`DEFAULT_WELCOME_TEXT`、`resolveWelcomeVariant`
      （`page` / `welcome-loading` / `welcome`）、`resolveWelcomeLoading`、`resolveWelcomeText`、
      `resolveWelcomeCapabilities`（握手载荷优先，本地 manifest 路由兜底）、`resolveWelcomeComponent`。
    - `composables/useWelcomePage.ts`：包成 `{ variant, visible, text, capabilities, loading }`；
      `useWebAssistant()` 以 `welcomePage` 透出（原先 headless 宿主只能自己再抄一遍判空与合并）。
    - `components/WelcomePage.vue`：默认呈现组件（`text` / `capabilities` / `loading`）。
  - **判空改用 runtime 事实**：`useRuntimeHost` 订阅 `view` 事件派生 `currentTag` / `hasPage`，不再用
    `navigate` 事件的粘性布尔（后者只表示「发生过导航」，加载失败不回退，且一旦导航过就再也回不到空态）。
  - **错误与欢迎页解耦**：错误独立成横幅（新增 `--wa-error-*` 主题变量），不再把空态整块替换成一行错误文本；
    有页面时错误也不再不可见。
  - **`loading` 语义修正**：由 `sessionReady` + `manifestSettled` 决定（**失败也算 settle**，不会死转圈），
    不再是「对话中」；刷新瞬间不会误显「暂无可操作页面」。
  - **修复「内置欢迎页永不渲染」**：`welcome` 的运行时 prop 含 `Boolean` 且无 `default` 时，Vue 会把缺省
    cast 成 `false`（runtime-core：`isAbsent && !hasDefault → value = false`）→ 被误判成「宿主关闭了欢迎页」，
    渲染区只剩最小空态。修法：`withDefaults` 显式 `welcome: undefined`（产物核对 `default: void 0`），
    并新增 `resolveWelcomeComponent` 兜住非组件值（`true` / 空串 → 回退内置组件）。
  - **覆盖优先级不变**：`#welcome` 插槽 > `welcome` prop > 内置 `WelcomePage` > `welcome=false` 最小空态；
    `#welcome` 插槽入参升级为**合并后的完整状态**（`WelcomePageSlotProps`）。
  - **`protocol`**：`session.ready.welcome = { text, capabilities[] }`（`WelcomePayload` / `WelcomeCapability`），
    随握手一并下发，供欢迎页渲染能力卡片；缺失时客户端用本地 manifest 路由兜底。
  - **首屏默认不自动打开页面**：`initialPage`（`boolean | string`）显式化；缺省 = 欢迎页先出现。

### Patch Changes

- Updated dependencies [31df00c]
- Updated dependencies [31df00c]
  - @webassistant/protocol@0.1.0
