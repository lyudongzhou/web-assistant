## 1. P0：内核与渲染面解耦（packages/wc-runtime-core）

- [x] 1.1 `src/surface.ts`：新增 `PageSurface`（`framework` / `mount` / `prepare` / `isReady` / `render` /
      `styles` / `stylesVersion` / `getPageExposed` / `bindRouter` / `dispose`）与 `RuntimeHistory`
      （`canGoBack` / `canGoForward` / `go`）契约
- [x] 1.2 `src/types.ts`：新增 `RuntimeSurfaceKind`（`'container' | 'host'`）、`HostSurface`
      （`framework` / `apply` / `getPageExposed?` / `history?` / `snapshot?` / `createRouterBridge?` / `dispose?`）
      与 `CreateRuntimeOptions` 的 `surface` / `hostSurface` / `adopt`；`Runtime.init(root?)` 允许不传挂载点
- [x] 1.3 `src/kernel.ts`：抽出内核装配（nav / servicesRef / state / eventBus / observer / apiBus 摘要 /
      activityBus / manifest 归一 / props 归一 / view-status-error 状态机 / `getPageExposed` 广播 /
      `applyNavigation` / `goInternal` / `navApi`），只依赖 `PageSurface` 与可选 `RuntimeHistory`
- [x] 1.4 `src/surfaceContainer.ts`：把容器实现搬入（容器懒建与挂载、`ensurePage` 页面加载与注册、
      `ensureBridge` memory router 桥、`render` 的 patch + `deactivateOthers`、页级 style scope、`styles` 版本）
- [x] 1.5 `src/surfaceHost.ts`：把注入的 `HostSurface` 适配为 `PageSurface`（`render` → `host.apply`；
      `styles` 恒空；`isReady` 恒 true；`prepare` 空实现；`getPageExposed` / `bindRouter` 委托）
- [x] 1.6 `src/kernel.ts`：外部历史模式（`RuntimeHistory` 存在时）：`canGoBack/canGoForward` 与 `navigate`
      事件读外部历史；提交一律 `replace: true` 使内核 entries 恒为单条；`back/forward/go` 走
      `history.go(delta)` + 「等一次 commit 或超时」（超时且未移动 → `out-of-range`）
- [x] 1.7 `src/kernel.ts`：`adopt` 支持 —— host 模式 init 时若有 `hostSurface.snapshot()` 则提交
      `source: 'initial'`（`adopt: false` 可关）
- [x] 1.8 `src/manifest.ts`：`NormalizeOptions.forHostSurface` —— `pages[].bundle` 可选、`containers` 可为空、
      `tag` 允许不含 `-`、`framework` 由预注册渲染面兜底；容器模式严格校验保持不变
- [x] 1.9 `src/runtime.ts`：退化为装配器（`surface === 'host'` → host 装配；缺省 container 装配），对外
      `createRuntime` 签名与返回类型不变
- [x] 1.10 `src/index.ts`：追加导出 `PageSurface` / `RuntimeHistory` / `HostSurface` / `RuntimeSurfaceKind`
      （既有导出与顺序不变）

## 2. P0 验证：容器模式等价性

- [x] 2.1 `pnpm --filter @webassistant/wc-runtime-core build` 通过
- [x] 2.2 `pnpm --filter @webassistant/wc-runtime-core test` 全绿，且**既有 12 个测试文件的断言零改动**
- [x] 2.3 `pnpm --filter @webassistant/wc-runtime-vue test` 全绿（容器 adapter / store 桥无回归）
- [x] 2.4 新增 `test/surface.test.js`：假 surface 驱动内核（不加载 bundle、不建容器）+ 外部历史语义
      （委托、越界）+ manifest 放宽校验 + `adopt` 开关

## 3. P1：vue 宿主渲染面（packages/wc-runtime-vue）

- [x] 3.1 `src/routerSync.ts`：从 `vueRouterBridge.ts` 抽出三机制（`toTarget` 转换、`applying` 计数器、
      guard 前移、`afterEach` 回流）与 `registerRoutes` 开关
- [x] 3.2 `src/vueRouterBridge.ts`：改为 `routerSync({ registerRoutes: true })` 的薄封装，
      `createVueRouter` / `createVueRouterBridge` / `toRouteRecords` 导出签名不变
- [x] 3.3 `src/hostSurface.ts`：`createVueHostSurface({ router, app?, passProps? })` → `HostSurface`
      （`apply` 走 `router.replace/push` 并对同路由跳过；`snapshot()` 读当前路由；`history` 委托
      `history.state.position` + `router.go`；`getPageExposed` 读 `matched[].instances.default.exposed`，
      `nextTick` 后取值；`createRouterBridge` 用 `routerSync({ registerRoutes: false })`）
- [x] 3.4 `src/hostSurface.ts`：props 旁路 `pageProps`（`shallowReactive`）+ `provideRuntimeContext(app, ctx)`
      （`tryUseRuntimeServices()` 由 `null` 变可用）+ 路由名一致性校验（缺失一次性报错）
- [x] 3.5 `src/hostRouter.ts`：`createVueHostRuntime(options)`（预注册 vue 宿主渲染面 + `defaultFramework: 'vue'` +
      `initial: null` + `adopt` 默认 true），不 import 容器 / CE 实现
- [x] 3.6 `package.json`：新增 `exports["./host-router"]` 子入口（与 `./host` 并列）
- [x] 3.7 `src/index.ts`：导出 `createVueHostSurface` / `createVueHostRuntime` 及类型
- [x] 3.8 新增 `test/hostSurface.test.js`：以 memory router 冒充宿主 router，验证「不 addRoute / 三机制 /
      `source: 'host'` 回流 / 同路由不重复 push / 无实例时 expose 为 null / 缺失路由名报错」
- [x] 3.9 `pnpm typecheck` + `pnpm test` 全绿


## 4. P2：chat-client host 模式

- [x] 4.1 `composables/useRuntimeHost.ts`：新增 `createRuntime?: (ctx: { base; initial }) => Runtime` 注入口
      （缺省仍走 `createHostRuntime`）；`init()` 允许无挂载点；host 模式 `styles` 空
- [x] 4.2 `composables/useRuntimeHost.ts`：`hasPage` 在 host 模式改为「当前路由命中页面目录」派生
- [x] 4.3 `composables/useWebAssistant.ts`：透传 `surface` / `createRuntime`；host 模式不传 `initialPage`
- [x] 4.4 `WebAssistant.vue` + `types.ts`：`surface?: 'container' | 'host'`、`createRuntime?`；host 模式隐藏
      渲染区（保留对话 / 错误横幅 / 当前页指示）
- [x] 4.5 单实例约束：host 模式检测多实例并 `console.warn`（apiBus / 网络观测为全局副作用）
- [x] 4.6 `pnpm --filter @webassistant/chat-client test` + `pnpm typecheck` 通过

## 5. P2：接入面（wc.pages.json 可选 container）

- [x] 5.1 `packages/protocol/src/wcPages.ts`：`WcPagesConfig.container` 变可选并补充注释（host 批次不声明）
- [x] 5.2 `packages/vite-plugin-wc/src/config.ts`：`loadWcPages` 不再强制 container；`wcVuePlugin` /
      `wcBuildPlugin` 侧补「WC 构建必须声明 container」校验
- [x] 5.3 `packages/analyzer/src/analyze.ts`：缺 `container` 时输出不写 `containers`，页面不写 `bundle`
      （其余字段不变）
- [x] 5.4 `packages/vite-plugin-wc/src/manifest.ts`：同样跳过 `containers` / `bundle`，保证
      `wcManifestPlugin` 可在普通 SPA 配置里独立使用
- [x] 5.5 `pnpm --filter @webassistant/analyzer test` + demo `pnpm analyze` 不回归（现有 WC 批次 manifest 保持原样）

## 6. P2：demo 端到端验收台

- [x] 6.1 `packages/demo-app/host.html` + `src/host-main.ts`：SPA（现有 router + `<router-view>`）+ 悬浮面板
      （`surface="host"` + `createVueHostRuntime`），不动既有 SPA / WC 两条链路
- [x] 6.2 `packages/demo-app/vite.config.ts`：多页入口（`index.html` + `host.html`）+ `/ws` 代理到 agent-server；
      根 `package.json` 新增 `dev:host` 脚本
- [x] 6.3 验收：agent「打开数据源管理」→ 宿主 URL 变化 + `<router-view>` 渲染真实页面 + 面板仍在
- [x] 6.4 验收：用户点击宿主导航 / 浏览器后退 → 内核收到 `source: 'host'` 导航并同步 agent
- [x] 6.5 验收：`call_page_method` 命中真实组件 `defineExpose`（`UserList.refresh` / `setKeyword`）
- [x] 6.6 验收：接口数据经 `observeNetwork` 或 `apiBus` 回传 agent（`page.data`）
- [x] 6.7 验收（失败路径）：manifest `name` 与宿主路由不一致 → 明确报错；宿主守卫拒绝 agent 导航 →
      结构化失败且 URL 不变

## 7. 文档与发布

- [x] 7.1 `PROJECT.md`：拆出「用法 A（容器/WC）」与「用法 B（宿主直连）」；修订「唤一真相源」表述为
      「URL 与内核双向镜像，URL 为最终裁决」；补 host 模式限制清单
- [x] 7.2 `docs/INTEGRATION_GUIDE.md`：新增「用法 B 接入清单」（装什么 / 不装什么、改哪 2 处代码、命令、
      部署物对照、4 条硬规矩、能力差异表）
- [x] 7.3 `packages/wc-runtime-core/README.md`、`packages/wc-runtime-vue/README.md`：补内核 / 渲染面分层与
      host surface 用法与已知限制
- [x] 7.4 changeset（`wc-runtime-core` / `wc-runtime-vue` minor；`chat-client` minor；protocol / analyzer /
      vite-plugin-wc patch）
- [x] 7.5 `openspec validate add-host-router-surface --strict` 通过；`pnpm typecheck` + `pnpm test` 全绿

## 8. 可选批次（本次不实施，仅登记）

- [ ] 8.1 analyzer `--from-router`：从宿主 `src/router/*` 生成 manifest（AST 静态解析；是否引入 vite
      `ssrLoadModule` 待定），配合 `meta.wa = { tag?, title?, rules? }` 实现「router 即配置」
- [ ] 8.2 per-route surface 混合模式：`Route.surface?: 'container' | 'host'`，runtime 同时持有两个渲染面并切换
- [ ] 8.3 内核物理拆包：把 `kernel.ts` + `surface*.ts` 拎成独立 `runtime-core` 包
