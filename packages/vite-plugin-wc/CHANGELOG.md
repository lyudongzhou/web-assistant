# @webassistant/vite-plugin-wc

## 0.2.1

### Patch Changes

- Updated dependencies [8a2f9e3]
- Updated dependencies [8a2f9e3]
- Updated dependencies [9faad13]
  - @webassistant/protocol@0.5.0
  - @webassistant/analyzer@0.3.1
  - @webassistant/wc-runtime-core@0.4.1

## 0.2.0

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
  - @webassistant/analyzer@0.3.0
  - @webassistant/wc-runtime-core@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @webassistant/protocol@0.3.0
  - @webassistant/analyzer@0.2.0
  - @webassistant/wc-runtime-core@0.3.2

## 0.1.2

### Patch Changes

- Updated dependencies [258d331]
  - @webassistant/wc-runtime-core@0.3.0
  - @webassistant/protocol@0.2.0
  - @webassistant/analyzer@0.1.4

## 0.1.1

### Patch Changes

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

- Updated dependencies [7e86e8d]
  - @webassistant/wc-runtime-core@0.2.0
  - @webassistant/protocol@0.1.1
  - @webassistant/analyzer@0.1.1

## 0.1.0

### Minor Changes

- 31df00c: **项目规则：`wc.pages.json` → `manifest.rules` → system prompt**（两级规则文档，改规则无需重启 agent-server）

  - **`analyzer`**：新增 `rules.ts`（`resolveRuleEntries`）—— 把 `wc.pages.json` 的 `rules` 声明
    （文件路径 / 目录（自动收集 `.md`、按文件名排序）/ 内联 `{ name, content }`，支持 frontmatter
    `name` / `disabled`，字段对齐 Cline SDK 的 `RuleConfig`）解析成 `ManifestRule[]`；
    **analyzer 与 `vite-plugin-wc` 共用同一实现**，避免两条生成路径漂移。
  - **`protocol`**：新增 `ManifestRule` 与 `manifest.rules` / `pages[].rules` 字段、`wcPages` 的 `rules` 声明类型。
  - **`vite-plugin-wc`**：manifest 增量生成接入 rules —— 指纹变化即重算；未声明但旧 manifest 有 `rules` →
    保留旧值（与 `dataSources` 同款「手工字段保留」，页面级同样适用）；dev watch 把规则文件/目录纳入监听，
    改动即增量重生成。
  - **agent-server**（不在 changeset）：`ManifestService.getRules()` + `buildAgentContext()` 把 manifest 级规则
    拼进 system prompt 的「项目规则」段（**优先于通用规则**）、页面级规则拼在「可用页面」列表里对应页面条目下
    （跳过 `disabled`）；本地 manifest 走 mtime 热重载、远程走定期刷新。

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
  - @webassistant/analyzer@0.1.0
  - @webassistant/wc-runtime-core@0.1.0
