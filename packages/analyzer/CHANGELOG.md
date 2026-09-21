# @webassistant/analyzer

## 0.3.2

### Patch Changes

- Updated dependencies [f911e93]
  - @webassistant/protocol@0.6.0

## 0.3.1

### Patch Changes

- Updated dependencies [8a2f9e3]
- Updated dependencies [8a2f9e3]
- Updated dependencies [9faad13]
  - @webassistant/protocol@0.5.0

## 0.3.0

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

## 0.2.0

### Minor Changes

- feat(demo): demo-app 重写为展示应用 + `wc.pages.json` 可声明 `dataSources`

  - **protocol**：`WcPageEntry` 新增 `dataSources?: ManifestDataSource[]` —— 数据源声明的**单一来源**
    回到清单文件（此前只能手改产物 manifest，下次 `pnpm analyze` 会被冲掉）。
  - **analyzer**：把页面条目的 `dataSources` 原样写进 `manifest.pages[].dataSources`（未声明不写字段）；
    单测覆盖透传与「未声明即省略」。
  - **demo-app 重写为展示应用**（业务页干净、探针集中进 `/lab`）：
    - 新增 `src/api/*`（每个资源一个模块，上报调用点收拢在这里）、`src/layout/AppShell.vue`、
      `src/styles/tokens.css`（兼作 chat-client 主题变量）、`api/query.ts` 等。
    - 页面重写：`Dashboard` / `UserList` / `UserDetail` / `OrderList` / `DatasourceAdmin` / `Settings` /
      `Lab`（新）/ `Login`（新，宿主自己的路由，演示登录守卫 + token）；删除 `AppDashboard` /
      `ProductList` / `GraphDemo`（并入 Lab）/ `TestCmp`（并入 Lab）/ `data.ts`。
    - `serve.mjs` 重写为小型 mock 后端：用户/订单/指标/数据源 CRUD + 分页筛选 + `?fail=500|401|slow`
      错误注入 + `/api/settings` 需要 Authorization。
    - 清单重写：`wc.host.json` / `wc.pages.json` 均声明 `dataSources`（如 `/api/users` 只暴露
      `id/name/role` 且 `maxRows: 6`），路由与 manifest 的 `name` 严格对齐。
    - 上报口径保持「调用点显式」：带 `reportData(source, data, { url })` 才走白名单裁剪；
      失败路径也上报（`*-error`，刻意不带 url 以免被字段白名单裁空）。
    - 文档：新增 `packages/demo-app/README.md`（页面 ↔ 能力映射 + 验收清单）；同步 PROJECT.md / README.md /
      `rules/domain.md`。

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

## 0.1.4

### Patch Changes

- Updated dependencies [258d331]
  - @webassistant/protocol@0.2.0

## 0.1.3

> 0.1.1 / 0.1.2 / 0.1.3 是同一份内容：发布时**本地网络侧的代理缓存**把刚上传的 tarball 误报成 404，
> 排查过程中依次补发了 0.1.2 与 0.1.3（registry 上三个版本都可用，装 `latest` 即 0.1.3）。

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
  - @webassistant/protocol@0.1.1

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

### Patch Changes

- Updated dependencies [31df00c]
- Updated dependencies [31df00c]
  - @webassistant/protocol@0.1.0
