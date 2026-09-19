# detect-route-query-params

## Why

页面可以「不声明路由参数、却用 `route.query.x` 读入参」—— 真实项目里列表页的筛选 / 翻页 / 来源标记几乎都走 query。当前入参来源只有一处：
`wc.pages.json` 的 `path` 正则（`analyzer/src/parseComponent.ts:140 extractParams`、`vite-plugin-wc/src/manifest.ts:137` 各一份）。于是出现一条完整的断链：

1. 页面写 `const ruleName = computed(() => String(route.query.name || ''))`，manifest 的 `params` 为空（或只有 path 参数）→ **agent 的 prompt 里没有这个参数，永远不会传**。
2. 即使 agent 猜着传了 `render({ tag, params: { name } })`，`wc-runtime-core/src/navigation.ts:125 resolve()` 把它放进 `location.params`，而 **vue-router 4 对 path 里没声明的 params 直接丢弃**（实测 `[Vue Router warn] Discarded invalid param(s) "name"`）→ 页面 `route.query.name` 恒为 `''`。
3. `location.query` 目前只能由 `path: '/x?a=1'` 或 `navigationTarget.query` 填，而 agent 的 render 工具只有 `tag` / `params` / `props` —— **没有任何一条路能把「路径外键值」送进页面的 `route.query`**。

所以缺的不是「多扫一段源码」，而是**入参通道没有显式化**：谁走 path、谁走 query 必须被静态探测出来写进 manifest，并由 runtime 按通道下发。

## What Changes

- **协议（protocol）**
  - `ManifestParam` 新增 `in?: 'path' | 'query'`（缺省 `path`；**path 参数不写该字段**，只有 query 参数写，避免产物噪音与无意义 diff）。
  - `WcPageEntry` 新增 `query?: ManifestParam[]` 显式声明逃生口（动态键 / 模板不可见 / 想自带说明），与自动探测同名时以显式为准；真相源仍是 `wc.pages.json`。
- **analyzer**
  - 新增 `src/routeScan.ts`：`scanRouteAccess()` 纯 AST 探测源码里的 query / params 读取（`useRoute()` 绑定名、`const { query } = useRoute()`、别名、`route.query.x` / `['x']` / `` [`x`] ``、`{ name: ruleName }` 解构、模板 `$route.query.x`），带类型推断与诊断；
    `resolvePageParams()` 把 path 正则 + 探测结果 + 显式声明合并去重（键 = `(name, in)`）。
  - `analyze.ts` 用 `resolvePageParams`，把 `route.params.X` 与 path 对不上的情况、以及整块 / 动态读 `route.query` 的情况打印为 `⚠️` 诊断（**只警告不自动改 path**，避免动 URL 契约）。
- **runtime（wc-runtime-core）**
  - `navigation.ts resolve()`：按 `route.params[].in` 分流 —— query 键进 `location.query`（值 `String()` 收口），其余照旧进 `params`；显式 `target.query` 仍最高优先；未声明的键保持旧行为。
  - `sameLocation()` 计入 `query`：query 变化必须算一次新导航（否则 back 回不到上一个筛选条件、`duplicated` 误判吞掉跳转）。
  - `props.ts resolveProps()` 新增 `query` 入参：`params[name] ?? query[name]`，但**只对页面声明过的 prop** 归一（避免把 `route.query.id` 写成元素 `id` 属性）；`kernel.ts currentProps()` 传 `location.query`。
  - 容器 memory router 与 host 真实 router 已带 query（`routerSync.ts defaultApplyLocation` / `hostSurface.ts pushIfChanged`），**无需改动**。
- **vite-plugin-wc**：删除本地 `extractParams`，改用 analyzer 的 `resolvePageParams`，两条构建路径不再各算一套。
- **agent-server**：`buildAgentContext` 把参数按通道分段展示（`路径参数：` / `查询参数：`），并补一条规则句说明 `render` 的 `params` 同时承载两种通道。
- **demo-app**：新增独立示例页 `src/pages/QueryParamsDemo.vue`（`/query-params`，tag `query-params-demo`）——
  一页摆齐「6 种 query 读法 + 类型推断（string/number）+ 写回 URL + 清单显式 `query` 声明让 prompt 带说明」，
  并给出三种驱动方式（改地址栏 / 让助手说 / 控制台 `__waRuntime.navigate`）；`DatasourceAdmin.vue`（`path: /datasources`，无 `:param`）
  顺带用 `route.query.keyword` 做一个真实业务筛选；重新 `pnpm analyze` 核对 manifest 出现 `in: 'query'`。

## Capabilities

### New Capabilities

- `analyzer-route-inputs`: analyzer 静态探测页面源码里的路由入参读取，产出带通道标记（path / query）与类型推断的 `manifest.pages[].params`，并给出无法枚举 / 与 path 不一致的诊断。
- `runtime-route-input-channels`: runtime 按 manifest 的通道标记把 agent 的 `params` 分流到 `route.params`（path）与 `route.query`（query），两种渲染模式（容器 / 宿主直连）行为一致。

### Modified Capabilities

（无既有 spec 变更：specs 目录尚未归档任何 spec。）

## Impact

- `packages/protocol`：`manifest.ts`（`ManifestParam.in`）、`wcPages.ts`（`WcPageEntry.query`）、`README.md`。
- `packages/analyzer`：新增 `src/routeScan.ts`；`src/parseComponent.ts`（导出共享 `leadingComment`）、`src/analyze.ts`、`package.json`（exports `./routeScan`）、`README.md`、`test/routeScan.test.js`、`test/analyze.test.js`、新增 fixtures。
- `packages/wc-runtime-core`：`src/navigation.ts`、`src/props.ts`、`src/kernel.ts`、`src/types.ts`（注释）、`test/navigation.test.js`、新增 `test/routeInputs.test.js`。
- `packages/wc-runtime-vue`：无代码改动（桥已带 query），仅回归验证。
- `packages/agent-server`：`src/manifest/manifest.service.ts`、`test/manifest.service.test.ts`。
- `packages/vite-plugin-wc`：`src/manifest.ts`。
- `packages/demo-app`：`src/pages/DatasourceAdmin.vue`、`public/wc/manifest.json`（重新生成）。
- 文档：`docs/analyzer-type-resolution.md`（补记）、`docs/INTEGRATION_GUIDE.md`（排查项）、`PROJECT.md`（§6.7 / §6.9）、`TODO.md`、`.changeset/*.md`。
