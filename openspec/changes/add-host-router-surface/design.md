# add-host-router-surface — 设计

## Context

现状（读码结论）：

- `wc-runtime-core/src/runtime.ts`（474 行）把五件事焊在一起：① 导航真相源（`navigation.ts`）② 服务 / 状态 /
  事件 / 观测器 / apiBus / 留痕 ③ 页面加载与注册（`loader.ts` + `adapter.definePage`）④ 渲染表面
  （`containers.ts` + `patchContainer`）⑤ 框架 router 桥（`vueRouterBridge.ts` 的 memory router + 哑组件）。
  只有 ③④⑤ 是 WC 专属。
- 对外门面：`wc-runtime-vue` 既是「批次容器实现」（`container.ts` / `definePage.ts`）又是「宿主门面」
  （`index.ts` 的 `createVueRuntime`、`host.ts` 的零框架宿主入口）。
- 宿主侧接线在 `chat-client`（`useRuntimeHost` / `useWebAssistant` / `WebAssistant.vue`），它通过
  `wc-runtime-vue/host` 子入口消费 runtime，从而不把 vue-router 带进自己的产物。
- agent 侧零耦合：agent-server 只读 manifest 的 `tag/name/title/description/props/exposes/emits/dataSources/rules`，
  不依赖 `bundle`；`render(tag)` / `call_page_method` / `page.*` 协议与本次新增用法完全兼容。

约束（不变量）：

1. 默认 `surface: 'container'`，既有对外 API（`createRuntime` / `createVueRuntime` / `/host`）与行为不变。
2. 三机制（guard 前移 / `applying` 计数器 / `afterEach` 回流）只保留**一份**实现，两种用法共用。
3. 内核不含 WC / DOM 概念：不出现 bundle / CE / shadow / 容器 / 「tag 必须含 `-`」。
4. core 仍只有 `dom.ts` / `styleSink.ts` 触碰 DOM（`typeof` 守卫），其余可在 Node 里直接单测。

## Goals / Non-Goals

**Goals:**

- 新增「用法 B：宿主直连」—— agent 的导航落到宿主真实 vue-router，页面在宿主 `<router-view>` 渲染，
  零编译、零容器、零样式隔离；宿主的 URL / history / 守卫 / 登录态 / 样式全部生效。
- 把内核与渲染面在**同一包内**拆开（`kernel.ts` + 两个 surface 实现），为将来物理拆包（`runtime-core` 独立包）
  留出无缝边界。
- 宿主接入成本最小：2 处代码（构造 + 注入）+ 1 份页面清单；页面代码零改动。

**Non-Goals（本次不做）:**

- analyzer `--from-router`（从宿主 router 表自动生成 manifest）—— 列为可选批次。
- per-route surface 混合模式（部分页面 WC、部分宿主直连）—— 仅预留字段，不实现切换。
- 悬浮球 / 抽屉等面板 UI 形态改造。
- react 批次、iframe adapter、嵌套子路由。

## Decisions

### D1 分层形状：同包内拆出内核 + 两个渲染面（路线 C）

- 新增 `kernel.ts`：装配 `nav`（NavigationController，唯一真相源）+ `servicesRef` + `state` + `eventBus`
  + `NetworkObserver` + `apiBus` 摘要 + `activityBus` + manifest 归一 + props 归一 + 视图状态机
  （`view` / `status` / `error` / `lastCommitAt`）+ `getPageExposed` 广播 + 导航编排（`applyNavigation` /
  `goInternal` / `navApi`）。
- 新增 `surface.ts`：`PageSurface` 与 `RuntimeHistory` 契约（内核只依赖这两个）。
- 新增 `surfaceContainer.ts`：把 `runtime.ts` 的 ③④⑤ 搬进来（`ensurePage` / `ensureBridge` / `settle` 的
  container 分支 / `render` 的 `patchContainer` + `deactivateOthers` + `activateStyleScope`）。
- 新增 `surfaceHost.ts`：把宿主注入的 `HostSurface` 适配成 `PageSurface`（`render` → `host.apply` 且把
  `view.props` 交给宿主旁路；`styles` 恒空；`getPageExposed` 委托；`bindRouter` 委托宿主提供的
  `createRouterBridge`）。
- `runtime.ts` 退化为装配器：`createRuntime(options)` → `surface === 'host' ? host 装配 : container 装配`。
- **备选（否决）**：给 `RuntimeAdapter` 加 `hostOwned: true` 标记。否决理由：`mountContainer(handle, root)` 在宿主
  模式里语义空转（挂载点是什么？），两种用法会隐式分叉、可读性差；显式 `PageSurface` 才能让两种用法对称。
- **备选（否决）**：本次直接物理拆包（新建 `runtime-core` 包）。否决理由：一次性迁移 4 个包 + 13 个测试文件的
  import，风险集中在搬运而非设计；先内部分层验证契约，再拎包零返工。

### D2 三个扩展点收敛为两个

原计划有 `PropsChannel`（props 下发渠道）。复核发现 `RuntimeView.props` 已经承载归一后的 props，且现有 API
本来就没有「不导航改 props」的入口（无 `setProps`）。因此取消 `PropsChannel`，改由
`PageSurface.render(view, ctx)` 自带交付语义：

- container：`view.props` 由 adapter 写成 element property（现状不变，对象保持引用）。
- host：`createVueHostSurface` 把 `view.props` 写进响应式 `pageProps`，经 `provideRuntimeContext` 注入宿主 app，
  页面用 `useRuntimeServices().pageProps` 读（`passProps: false` 可关）。

### D3 历史归属：`RuntimeHistory` 外置

- container：不给 `RuntimeHistory` → 内核沿用 `NavigationController` 自己的 entries（现状）。
- host：`RuntimeHistory` 由宿主 surface 提供（`canGoBack = history.state.position > 0`，
  `go(delta) → router.go(delta)`）；内核在外部历史模式下：
  - `Runtime.canGoBack/canGoForward` 与 `navigate` 事件的 `canGoBack/canGoForward` 读外部历史；
  - 一律以 `replace: true` 提交 `nav.commit`，使内核 entries 恒为单条、永不与真实 URL 发散；
  - `back/forward/go` 走 `history.go(delta)`，随后「等一次 commit 或超时」再 settle；超时且位置未变 → `out-of-range`。


### D4 导航方向与防回环

- 出向（core → 宿主）：`surface.render(view, { replace, source })` → `router.replace/push({ name, params, query })`，
  受 `applying` 计数器保护（与 memory router 版共用 `routerSync.ts`）。
- 入向（宿主 → core）：`router.afterEach`（`applying === 0` 时）→ `commit({ source: 'host' })`；
  `router.beforeEach` 把 core 的守卫前移（`canNavigate` 为 false 时返回 `false`）。
- **不 `addRoute`**：宿主路由表是真相，core 的路由表只是页面目录；`registerRoutes: false` 与 memory 版共用同一份
  同步代码。
- 一致性校验（**D4 修订，见 revisions**）：init 时找出「manifest 声明但宿主 router 此刻没有」的页面并
  **一次性告警**（**不抛错** —— 真实项目的页面路由常是登录后 / 按权限才注册的，如 vben 的 access routes）；
  每次导航在 **commit 之前** 调 `PageSurface.canRender(route)`：返回原因即结构化失败
  （`reason: 'not-found'`）且**不推进内核状态**，避免「内核以为切了页、宿主 URL 没动」的分裂。
  桥的 `apply` 抛错同样被内核转成结构化 `load-failed`（不再以 rejection 冒泡）。

### D5 adopt：首屏把宿主当前路由纳入内核

host 模式 init 时若 `adopt !== false` 且 `hostSurface.snapshot()` 有值 →
`applyNavigation({ ...snapshot, replace: true, source: 'initial' })`，agent 一上来就知道用户在哪个页面。
host surface 的 `render` 对「已经是当前路由」的目标跳过 `router.push`（仅同步 props 旁路），避免多余的历史条目
与重复导航。

### D6 expose 读取

`router.currentRoute.value.matched.at(-1)?.instances.default?.exposed`（vue-router 4.6.4 的
`RouteRecordNormalized.instances` 已确认存在），在 `afterEach` 后 `nextTick()` 再取；取不到（未写
`defineExpose` / 实例未挂载）→ `keys` 为空数组，仍广播 `page-exposed-changed`（与 container 语义一致）。

### D7 emit：显式通道（已知能力缺口）

宿主真实页面没有 CE 边界，runtime 无法自动捕获 `defineEmits`。统一走
`useRuntimeServices().emit(name, payload)`（host 模式启动时由 `createVueHostRuntime` 把 context `provide` 进宿主
app，`tryUseRuntimeServices()` 由 `null` 变可用）。manifest 的 `emits[]` 仍由 analyzer 静态解析，agent 侧合同不变。

### D8 数据观测：零侵入优先

> ⚠️ **本条已被后续决策取代（见 `docs/agent-session.md` §6）**：`observeNetwork` 与 `NetworkObserver` 已删除。
> 现在的规则是「**调用点显式** `apiBus.report`」—— runtime 不采集任何请求，不调 = 零数据出网。
> 下面这段保留了当时的取舍记录。

host 模式下页面与 runtime 同副本，`observeNetwork: true` 拦截宿主 fetch/XHR 即为最准通道；`apiBus.report()`
仍可用（面向「页面想主动上报」）。因二者都是全局副作用，**同一页面禁止挂多个 assistant**（多实例时告警），
并写入文档硬规矩。

### D9 接入面：`wc.pages.json` 的 `container` 可选

host 批次的 `wc.pages.json` 不声明 `container`：analyzer 不写 `containers` 与 `pages[].bundle`；
`loadWcPages` 的「container 必填」校验移到 `wcVuePlugin` / `wcBuildPlugin`（WC 构建路径必须声明）。
`wcManifestPlugin` 保持可在普通 SPA 配置里单独使用（dev watch + build 产出 manifest）。
manifest 的 `name` **必须**等于宿主 route record 的 `name`（硬约束，见 D4 校验）。

### D10 决策清单（沿用已批准口径）

| # | 决策 | 取值 |
|---|---|---|
| D1 | agent 直传 props | host 模式随 `view.props` 走旁路 `pageProps`（`passProps:false` 可关；页面不读时不报错） |
| D2 | manifest 来源 | 沿用 analyzer + `wcManifestPlugin`；`--from-router` 列为可选批次 |
| D3 | agent 导航历史语义 | `replace`（不污染用户历史） |
| D4 | 面板形态 | host 模式隐藏渲染区，不做悬浮 UI |
| D5 | 多实例 | 禁止（全局副作用），多实例时告警 |
| D6 | 首屏 adopt | `true` |
| D7 | history | 委托宿主（内核 entries 停用） |
| D8 | emit | 只能显式 `ctx.emit`（文档标注为已知缺口） |

## Risks / Trade-offs

- [内核 / surface 拆分引入回归] → P0 定为「纯搬移 + 接线替换」：`pnpm test` 的既有测试断言**不得修改**，改动前后
  必须全绿；新增单测只做增量覆盖（host surface、外部历史、manifest 放宽）。
- [真相源语义变化] → host 模式下用户可改 URL / 浏览器后退，内核无法拒绝。文档把「唤一真相源」修订为
  「URL 与内核双向镜像，URL 为最终裁决」，并在 `navigate` 事件的 `source` 上如实区分 `host` / `agent`。
- [manifest 路由名漂移 / 路由尚未注册 → 404] → init 一次性告警 + commit 前 `canRender` 结构化失败（D4 修订）；
  接入文档把它列为硬约束第一条。
- [props 旁路半生效]（页面不读 `context.pageProps`）→ 文档明示；`passProps: false` 可整体关闭。
- [面板被路由卸载]（把 `<WebAssistant>` 挂在路由组件里）→ 文档硬规矩：必须挂在 `<router-view>` 之外；
  host 模式 `hasPage` 只是状态指示，不驱动面板内部渲染区。
- [外部历史下 `router.go` 无 Promise] → 「等一次 commit 或超时」策略 + `canGoBack` 二次判定，避免永远悬挂。
- [多实例全局副作用] → 运行时告警 + 文档禁止。

## Migration Plan

1. P0（内核解耦）：`pnpm build && pnpm test` 全绿（既有断言零改动）→ 证明容器模式等价。
2. P1（vue 宿主 surface）：新增 `routerSync` / `hostSurface` / `hostRouter` + 单测；`vueRouterBridge` 改为薄封装且
   既有两个测试仍绿。
3. P2（chat-client host 模式 + demo 验收台）：`pnpm typecheck` + demo 端到端验收（agent 导航改宿主 URL、
   用户后退回流、`call_page_method` 命中真实组件、接口数据回传）。
4. 文档与 changeset；若 P0–P2 通过，再把内核物理拆包列为后续独立变更。

回滚：默认 `surface: 'container'`，未使用 host 模式的宿主零感知；host 用法本身是新增开关，移除 `hostSurface`
注入即回到容器模式。

## Open Questions

- analyzer `--from-router`（可选批次）是否需要引入 vite `ssrLoadModule` 作为精确路径（否则退化为 AST 静态解析）——
  待该批次启动时单独确认。
- per-route surface 混合（WC 页面嵌在面板内 + 宿主页面直连）是否要支持，取决于实际接入反馈。
