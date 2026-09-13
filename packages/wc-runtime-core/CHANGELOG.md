# @webassistant/wc-runtime-core

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
