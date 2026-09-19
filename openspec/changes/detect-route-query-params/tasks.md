## 1. 协议层（packages/protocol）

- [x] 1.1 `src/manifest.ts`：`ManifestParam` 新增 `in?: 'path' | 'query'`（注释说明缺省 path、path 参数不写该字段）
- [x] 1.2 `src/wcPages.ts`：`WcPageEntry` 新增 `query?: ManifestParam[]`（显式声明逃生口，注释指向 `routeScan` 的自动探测）
- [x] 1.3 `README.md`：补 `ManifestParam.in` 与 `WcPageEntry.query` 说明

## 2. analyzer 探测（packages/analyzer）

- [x] 2.1 `src/parseComponent.ts`：导出 `leadingComment`（供 routeScan 复用，不改行为）
- [x] 2.2 新增 `src/routeScan.ts`：`scanRouteAccess()` —— `useRoute()` 绑定名 / `{ query } = useRoute()` 别名 / `route.query.x` / `['x']` / 解构（含重命名）/ 内联调用 / 模板 `$route.query.x`，产出 `queries` / `paramReads` / `warnings`
- [x] 2.3 `src/routeScan.ts`：类型推断（同名 prop > `String/Number/parseInt/parseFloat/Boolean` 包装 > 兜底字面量 > `=== 'true'` > `string`）与同名 prop 合并
- [x] 2.4 `src/routeScan.ts`：`resolvePageParams(routePath, componentPath | null, { props, explicit })` —— path 正则 + 探测 + 显式声明按 `(name, in)` 去重合并；诊断（`route.params.X` 无 path 段 / 整块读 query / 动态键）
- [x] 2.5 `src/analyze.ts`：改用 `resolvePageParams`，打印 `⚠️` 诊断；`PageFacts.params` 随之带上 `in`
- [x] 2.6 `package.json`：`exports` 增加 `./routeScan`；`src/analyze.ts` re-export 供 vite-plugin-wc 使用
- [x] 2.7 单测：新增 `test/routeScan.test.js` + fixture `RouteQueryPage.vue`（6 种写法 + 3 条 warning）；`test/analyze.test.js` 加「无 `:param` 页面 → `params` 含 `in: 'query'`」，fixtures `wc.pages.json` 增页面条目 — **实施注记：`test/routeScan.test.js` 7 条 + `test/analyze.test.js` 新增查询通道用例，analyzer 37 例全绿**
- [x] 2.8 `README.md`：§3 表格 `params[]` 行、§6 已知限制补 query 探测与诊断

## 3. runtime 通道（packages/wc-runtime-core）

- [x] 3.1 `src/navigation.ts`：`resolve()` 按 `in` 分流（`toQueryValue` 收口 string / string[]）+ 显式 `target.query` 优先
- [x] 3.2 `src/navigation.ts`：`sameLocation()` 计入 `query`
- [x] 3.3 `src/props.ts`：`ResolvePropsInput` 增加 `query?`；`route.params` 里 `in === 'query'` 跳过 props 归一；声明过的 props 从 `params[name] ?? query[name]` 取值
- [x] 3.4 `src/kernel.ts`：`currentProps()` 传 `location.query`；`src/types.ts` 注释补通道说明
- [x] 3.5 单测：新增 `test/routeInputs.test.js`（分流 / string 化 / 双通道 / query 变化算新导航 / props 两通道） — **实施注记：`test/routeInputs.test.js` 9 条：分流 / string 化 / null 丢弃 / 双通道 / 显式 query 优先 / query 变化算新导航 / props 两条通道；core 127 例全绿**
- [x] 3.6 回归：`test/navigation.test.js` / `test/runtime.test.js` / `test/manifest.test.js` 全绿（如有断言依赖 duplicated 语义则按新语义修正）

## 4. 两条构建路径收敛（packages/vite-plugin-wc）

- [x] 4.1 `src/manifest.ts`：删除本地 `extractParams`，改用 analyzer 的 `resolvePageParams`（含警告输出） — **实施注记：`generateManifestIncremental` 独立调用验证：插件路径产出的 params 与 analyzer 完全一致**
- [x] 4.2 `analyzePage` 与 `analyzer/src/analyze.ts` 的 params 组装保持一致（`in` 标记、空数组语义）

## 5. agent-server（prompt）

- [x] 5.1 `src/manifest/manifest.service.ts`：`buildAgentContext` 参数按 `in` 分段（`路径参数：` / `查询参数：`，带 description）
- [x] 5.2 规则段补一条：`render` 的 `params` 同时承载路径参数与查询参数，查询参数会被下发成 `?key=value`，页面用 `route.query` 读
- [x] 5.3 单测：`test/manifest.service.test.ts` 断言两行分段 + 新规则句

## 6. demo & 端到端验收

- [x] 6.1 `demo-app/src/pages/DatasourceAdmin.vue`：演示 `const keyword = computed(() => String(route.query.keyword || ''))`（path `/datasources` 无 `:param`）
- [x] 6.2 `pnpm analyze` 重新生成 `public/wc/manifest.json`，核对 `params` 出现 `{ name: 'keyword', type: 'string', in: 'query' }`
- [x] 6.3 手测（宿主直连）：agent「打开数据源管理，按名称 xxx 过滤」→ 真实 URL 出现 `?keyword=xxx`、页面筛选生效 — **（已实测 2026-09-19：`__waHostRuntime.navigate({ tag:'datasource-admin', params:{ keyword:'库' } })` → 真实 URL `#/datasources?keyword=%E5%BA%93`，页面过滤 5 → 3 行**
- [x] 6.4 手测（容器）：同一句话 → 页面在面板内渲染且 `route.query.keyword` 有值 — **（已实测 2026-09-19：容器验收台 `__waRuntime.navigate(...)` → 内存 router query 生效，shadow root 内页面同样过滤成 3 行**
- [x] 6.5 demo-app 新增独立示例页 `src/pages/QueryParamsDemo.vue`（`/query-params`，tag `query-params-demo`）：覆盖 6 种读法（包装调用 string/number、方括号键、别名、解构、模板 `$route.query`）+ 写回 URL（`router.replace({ query })`）+ 两种显式声明玩法；并注册进 `wc.pages.json`（带显式 `query` 声明）与宿主路由表 — **已实测 2026-09-19**：host 模式 `navigate({ params: { keyword:'同步', status:'running', sort:'name', tab:'巡检', from:'agent' } })` → URL 带全 5 个键、表格 7→2 行、chips 显示 tab/from；点第 2 页 → 页面写回 URL `?page=2&from=agent`（保留 from）；容器模式同一跳同样得到 2 行。`wc.pages.json` 的显式 `query` 声明还验证了「探测拿不到说明时用清单补」这条路。

## 7. 文档 / 发版

- [x] 7.1 `docs/analyzer-type-resolution.md`：追加「补记：路由 query 入参探测」小节
- [x] 7.2 `docs/INTEGRATION_GUIDE.md`：排查表「页面里 `useRoute()` 拿不到参数」一行更新为「path 外键值读 `route.query`，analyzer 会自动声明」
- [x] 7.3 `PROJECT.md`：§6.7 analyzer 能力、§6.9 能力对照表补「query 入参通道」
- [x] 7.4 `TODO.md`：勾掉/新增对应条目
- [x] 7.5 `.changeset/*.md`：protocol / analyzer / wc-runtime-core / wc-runtime-vue / vite-plugin-wc（minor，向后兼容增强）

## 8. 验证

- [x] 8.1 `pnpm --filter @webassistant/analyzer test`、`pnpm --filter @webassistant/wc-runtime-core test`、`pnpm --filter @webassistant/wc-runtime-vue test`、`pnpm --filter agent-server test` 全绿 — **（127 core + 42 vue + 31 chat-client + 37 analyzer + 29 agent-server，0 失败**
- [x] 8.2 `pnpm -r typecheck` 通过 — **（8/8 包 Done，含 vue-tsc 的 demo-app / chat-client**
- [x] 8.3 `openspec validate detect-route-query-params --strict` 通过
- [x] 8.4 `pnpm build:libs` 通过（analyzer → vite-plugin-wc 顺序不变） — **（build:libs + build:ce 均通过；build:ce 顺带验证了 vite-plugin-wc 的 manifest 生成路径**

## 9. 二轮收口（2026-09-19）

- [x] 9.1 `protocol/src/wcPages.ts`：`WcPageEntry.query` 收窄为 `Array<Omit<ManifestParam, 'in'>>`（通道固定 query，声明里写 `in` 无效）
- [x] 9.2 `analyzer/src/routeScan.ts`：query 参数的 `description` 只取声明处注释**第一行**（`firstLine`），续行（开发者向说明）不出网
- [x] 9.3 `analyzer/src/routeScan.ts`：诊断按通道指路 —— params 通道不再建议声明不存在的 `params` 字段（改指「补 path 段位 / 改读 route.query.x」）
- [x] 9.4 `analyzer/src/routeScan.ts`：显式声明与 path 段同名 → 新增「会下发 path + query 双通道两条入参」告警
- [x] 9.5 单测：`routeScan.test.js` +2 例（params 通道文案 / 双通道告警）+ 多行 JSDoc 首行断言 + fixture `ParamsRestPage.vue` — **analyzer 39 例全绿**
- [x] 9.6 文档口径：analyzer README §3.1（诊断表 + 「显式 `query` 可选」）、demo-app README §2.2、`PROJECT.md` §6.7.1.1、
      `docs/analyzer-type-resolution.md` 补记、`.changeset/route-query-params.md`
- [x] 9.7 验证：demo 重跑 `pnpm analyze` → **manifest 零结构差异、零告警**（本地探测与产物一致；AI 字段走缓存不变）
