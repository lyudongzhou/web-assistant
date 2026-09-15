# add-host-router-surface

## Why

当前 agent 操作页面只有一种用法 ——「容器 / WC 模式」：页面必须先经 `vite-plugin-wc` 编译成 Web Component，
再由 runtime 的容器渲染进 assistant 面板内部。它要求被服务项目新增 `wc.pages.json` / `vite.ce.config.ts` /
容器入口，额外产出并部署 `dist-ce/`；页面被放进 shadow DOM，于是附带一整套适配成本：样式隔离泄漏点
（UI 库浮层 teleport 到 body）、双份框架副本（宿主 store/响应式不互通）、`defineExpose` / `emit` 桥接。

很多项目真正要的是更朴素的用法：**agent 直接操作宿主自己的 vue-router 与路由页面** —— 页面依旧在它原来的
位置（宿主的 `<router-view>`）渲染，只是「谁来切换路由」多了 agent 这个发起方。这条用法不需要编译、不需要
容器、不需要样式隔离，并天然共享宿主自己的路由守卫、登录态、URL 与样式体系。

## What Changes

- **core：把「内核」与「渲染面」解耦**（对外 API 不变，container 模式行为逐字节等价）
  - 新增 `PageSurface` 扩展点（`mount` / `prepare` / `isReady` / `render` / `styles` / `getPageExposed` /
    `bindRouter` / `dispose`）与 `RuntimeHistory` 扩展点（`canGoBack` / `canGoForward` / `go`）。
  - `runtime.ts` 从「编排 + WC 实现」退化为装配器：`createRuntime({ surface: 'container' | 'host' })`。
  - 容器 / WC 实现（容器管理、bundle 加载、样式登记与页级 scope、memory router 桥、页面注册）迁入
    `surfaceContainer.ts`；内核装配（导航真相源 / 服务 / 状态 / 事件 / 观测 / 留痕 / 页面目录 / 视图状态机）
    收进 `kernel.ts`。
  - props 不新增下发通道：agent / 宿主直传 props 随 `RuntimeView.props` 下发，交付方式由 surface 决定
    （container 写 element property；host surface 写旁路 `pageProps`）。
- **core：manifest 归一化支持宿主模式**
  - `pages[].bundle` 变可选、`containers` 可为空、`tag` 允许不含 `-`；页面 `framework` 由预注册 surface 兜底。
  - `CreateRuntimeOptions` 新增 `surface` / `hostSurface` / `adopt`；`init(root?)` 允许不传挂载点（host 模式无需挂载点）。
- **新增该用法的实现（`wc-runtime-vue`）**
  - 抽出 `routerSync.ts`（guard 前移 / `applying` 计数器防回环 / `afterEach` 回流），memory router 与真实 router 共用同一份实现。
  - 新增 `createVueHostSurface({ router, app?, passProps? })`、`createVueHostRuntime(options)`，以及子入口
    `@webassistant/wc-runtime-vue/host-router`（不引入容器 / CE / 样式机制）。
  - 真实 router 语义：不 `addRoute`（宿主路由表已存在）、`setRoutes` 校验 `router.hasRoute(name)`、
    `getPageExposed` 读 `currentRoute.matched[].instances.default.exposed`、history 委托 `router.back/forward/go`。
- **chat-client：host 模式面板**
  - `useRuntimeHost` 新增 `createRuntime` 注入口（由宿主用 `createVueHostRuntime` 构造后注入）；host 模式无渲染区，
    `hasPage` 表示「当前路由是否命中页面目录」。
  - `WebAssistant` / `useWebAssistant` 新增 `surface` / `createRuntime`；chat-client 不因此依赖 vue-router。
- **接入面：`wc.pages.json` 支持不声明 `container`**（host 批次）；analyzer 在此情况下不写 `containers` 与
  `pages[].bundle`，`loadWcPages` 的 container 必填校验移到 WC 构建侧。`wcManifestPlugin` 可在普通 SPA
  （非 CE）配置里单独使用。
- **demo：新增 host 模式验收台**（`demo-app/host.html` + `src/host-main.ts` + `pnpm dev:host`），
  既有两条链路（SPA / WC）不受影响。
- **文档**：`PROJECT.md` 拆出「用法 A / 用法 B」并修订「唤一真相源」表述；`docs/INTEGRATION_GUIDE.md`
  新增用法 B 接入清单与硬规矩；相关包 README + changeset。

> 兼容性：**非 breaking**。默认 `surface: 'container'`，既有对外 API、`createRuntime` 行为、WC 产物与
> `/host` 子入口全部保持不变；`host` 为**新增用法**。`ClientMessage` / manifest 均为向后兼容的字段放宽。

## Capabilities

### New Capabilities

- `runtime-page-surface`: 内核（导航 / 服务 / 状态 / 事件 / 观测 / 留痕 / 页面目录）与渲染面解耦的契约与装配方式；
  container 与 host 两种渲染面共享同一份内核实现，且 container 行为与解耦前等价。
- `host-router-surface`: Vue 宿主直连渲染面的行为契约：agent 导航驱动真实 router、用户导航回流、history 委托、
  `defineExpose` 读取、路由名一致性校验与结构化失败。
- `chat-client-host-mode`: 面板 host 模式：runtime 由宿主注入、无渲染区、页面在宿主位置渲染、单实例约束。

### Modified Capabilities

（无既有 spec 变更：`openspec/specs/` 目前为空，本变更不修改任何既有 capability 的需求。）

## Impact

- `packages/wc-runtime-core`：新增 `surface.ts` / `kernel.ts` / `surfaceContainer.ts` / `surfaceHost.ts`；
  `runtime.ts` 改装配器；`manifest.ts` 放宽校验；`types.ts` 新增 `HostSurface` / `RuntimeSurfaceKind` /
  `CreateRuntimeOptions.{surface,hostSurface,adopt}`；`index.ts` 追加导出（既有导出不变）。
- `packages/wc-runtime-vue`：新增 `routerSync.ts` / `hostSurface.ts` / `hostRouter.ts`；`vueRouterBridge.ts`
  改为 `routerSync` 的薄封装（既有导出签名不变）；`package.json` 新增 `./host-router` 子入口。
- `packages/chat-client`：`composables/useRuntimeHost.ts`、`composables/useWebAssistant.ts`、
  `WebAssistant.vue`、`types.ts` 增加 host 模式。
- `packages/protocol`：`WcPagesConfig.container` 变为可选（含注释与命名规则说明）。
- `packages/analyzer` / `packages/vite-plugin-wc`：无 `container` 时不写 `containers` / `pages[].bundle`；
  `loadWcPages` 的 container 必填校验移到 `wcVuePlugin` / `wcBuildPlugin` 侧。
- `packages/demo-app`：新增 host 验收台（`host.html`、`src/host-main.ts`）与 `dev:host` 脚本。
- 文档：`PROJECT.md`、`docs/INTEGRATION_GUIDE.md`、`packages/*/README.md`、changeset。
- 依赖方向不变；**不新增第三方依赖**（analyzer 的 `--from-router` 属可选批次，不在本次范围）。
