# detect-route-query-params — 设计

## Context

读码结论（当前实现的事实）：

- **入参来源只有一条**：`analyzer/src/parseComponent.ts:140 extractParams(routePath)` 用正则扫 `:param`；
  `vite-plugin-wc/src/manifest.ts:137` 有一份**完全相同的复制品**。两者都不看页面源码。
- **manifest → prompt**：`agent-server/src/manifest/manifest.service.ts:145` 把 `page.params` 渲染成「必要/可用路由参数」。
  `params` 为空 ⇒ agent 无法知道该传什么。
- **agent → runtime**：`chat-client/src/composables/useWebAssistant.ts:269` 把 render 工具的 `{ tag, params, props }` 转成
  `navigate({ tag, params, props })`；`NavigationTarget` 里有 `query?: Record<string, string | string[]>`（`core/src/types.ts:72`），
  **但 render 工具没有 query 入参，也没有任何代码去填它**。
- **runtime → 页面**：`core/src/navigation.ts:125 resolve()` 把 `target.params` 原样放进 `location.params`，
  `location.query` 只来自 `target.query` 或 `path` 里的 `?a=1`。
- **vue-router 的行为（实测 vue-router 4.6.4）**：`push({ name, params: { name: 'x' } })` 对 `path` 里没有 `:name` 的路由
  会打印 `Discarded invalid param(s) "name"` 并丢弃 —— 所以「路径外键值」**只能**通过 `query` 送达；
  两种渲染模式都成立：容器走 `routerSync.ts:44 defaultApplyLocation`（已带 `query`），宿主走
  `hostSurface.ts:137 pushIfChanged`（已带 `query` 且 `sameQuery` 比较 query）。

不变量：

1. `wc.pages.json` 仍是唯一真相来源（页面入参的显式声明也写在那里，和 `rules` / `dataSources` 同款策略）。
2. 「本地先定稿、AI 只做语义」不破：通道判定与类型推断全在本地（AST + 正则），AI 不参与新增结构。
3. manifest 向后兼容：`in` 缺省 `path` 且 path 参数不写该字段 —— 旧 manifest、手写 manifest、旧 runtime 都不受影响。
4. runtime 对「未在 manifest 声明的键」行为不变（仍留在 `params` 并可按 props 归一），避免既有页面回归。

## Goals / Non-Goals

**Goals**

- 页面「用 `route.query.x` 读入参」这件事能在 manifest 里表达（含类型与说明），agent 据此传参。
- agent 传的同一个 `params` 对象按 manifest 的通道标记分流到 `route.params` / `route.query`，容器与宿主两种模式行为一致。
- 探测不到 / 不可交付的入参**当次就给出诊断**，而不是静默生成一个残废的 manifest。

**Non-Goals**

- `routes[].props`（`route.query` → prop 的函数式映射）支持。
- `route.hash` / `route.meta` / 选项式 `this.$route` 的探测。
- 「自动改写 `path`」：`route.params.X` 与 `path` 不一致时只警告（改 path 会动 URL 契约）。
- 让 AI 发明 manifest 里不存在的参数。
- per-page 的 query schema 校验（类型只用于规划与人读，不做出网校验）。

## Decisions

### D1 通道用 `ManifestParam.in?: 'path' | 'query'`（单列表）

- 备选：新增 `manifest.pages[].query[]` 独立列表。选 `in` 的理由：agent 的 render 入参只有一个 `params` 对象，
  运行时按标记分流即可，manifest / runtime / prompt 三处都只需认识一个列表；查询参数天然是「页面的入参」
  （和 path 参数同质），分两张表会让 `resolveProps` / prompt / 归一化都要写两遍。
- 只有 query 参数写 `in`：path 参数保持零字段（产物更干净，旧 consumers 无感）。
- 去重键是 `(name, in)` 而不是 `name`：同名双声明（`/users/:id` 同时读 `route.params.id` 与 `route.query.id`）合法且有意义。
- 逃生口 `WcPageEntry.query`：动态键、模板不可见、想自带说明时用；与探测同名同通道时以显式为准。

### D2 探测放在新增的 `routeScan.ts`，与 `parseComponent` 分层

- `parseComponent` 的职责是「组件形状」（props / events / exposes / description）；入参是**路由**的关注点，
  混进去会让 `ParsedComponent` 的语义变糊（且 `test/parseComponent.test.js` 用 `deepEqual` 锁死了整个对象）。
- `routeScan.ts` 自己用 `@vue/compiler-sfc` + `@babel/parser` 解析（多一次解析，CLI 场景可忽略；
  相比之下 vue-tsc program 的构建才是大头），复用 `parseComponent.ts` 的 `leadingComment`（改为导出）。
- 入口形状：
  ```ts
  scanRouteAccess(filePath, { props? }): { queries: ManifestParam[]; paramReads: string[]; warnings: string[] }
  resolvePageParams(routePath, componentPath | null, { props?, explicit? }): { params: ManifestParam[]; warnings: string[] }
  ```
  `resolvePageParams` 是 analyzer 与 vite-plugin-wc 的唯一入口，顺手消掉两份 `extractParams`。

### D3 识别「路由对象」而不是全局匹配 `.query.`

只认三种来源，把误报压到「最坏多一个 query 键」（agent 不会乱传、页面忽略）：

1. `useRoute()` 的绑定名（`const route = useRoute()` / `const r = useRoute()`）；
2. `const { query } = useRoute()` / `const { query: q } = useRoute()` 得到的 query 别名；
3. 模板里的 `$route`（全局）与上面收集到的名字。

`route.query['x']` / `` [`x`] `` 取字符串字面量键；`const { x } = route.query` 取解构键（含重命名）。
「整块读」（`{ ...route.query }` / `Object.keys(route.query)` / `route.query[key]`）无法枚举 → 只出 warning。

### D4 类型推断用「props 声明 > 使用点包装 > 字面量兜底 > 比较 > string」

query 值在 URL 里天然是字符串，`type` 主要给 agent 规划与 prompt 展示用（因此纯启发式足够，
不必把 `route.query.x` 丢给 vue-tsc —— `LocationQuery` 的静态类型是 `string | null | (string|null)[]`，展开反而没信息）。
同名 prop 已声明时直接复用 prop 类型，并与 prop 合并（不再产生第二个同名 query 参数，避免 prompt 里出现两条同名项）。

### D5 runtime 分流规则（`resolve()`）

```ts
const queryNames = new Set(route.params.filter((d) => d.in === 'query').map((d) => d.name))
const pathNames  = new Set(route.params.filter((d) => d.in !== 'query').map((d) => d.name))
for (const [key, value] of Object.entries(target.params ?? {})) {
  if (queryNames.has(key)) query[key] = toQueryValue(value)          // string 化 / 数组元素 string 化 / null 丢弃
  if (pathNames.has(key) || !queryNames.has(key)) params[key] = value // 同名双通道都下发；未声明的键保持旧行为
}
```

- `target.query` 在最后合并（显式优先）。
- `location.path = fillPath(route.path, params)` 不变（query 不进 path）。
- `sameLocation` 补 query 比较：query 变化必须是一次新导航（否则 back 回不到上一个筛选条件）。
- `resolveProps` 只对**路由声明过的 props**从 query 取值（`params[name] ?? query[name]`）：
  既让「既读 route.query 又声明了 prop」的页面两条路都通，又不会把 `route.query.id` 写成元素 `id` 属性。
  `route.params` 里 `in === 'query'` 的定义**跳过 props 归一**（避免属性注入）。

### D6 prompt 按通道分段 + 一条规则句

`路径参数：id(string)` / `查询参数：keyword(string)（按名称过滤）` + 规则句说明「render 的 `params` 同时承载两种通道，
标为查询参数的键会被下发成 `?key=value`，页面通过 `route.query` 读取」——工具 schema 不变（`params: object` 已是宽松对象）。

## Risks / Trade-offs

| 风险 | 对策 |
|---|---|
| 误报（把无关 `.query.` 当路由 query） | 只认 `useRoute()` 绑定名 / 解构别名 / `$route`；最坏后果是多一个 query 键 |
| 漏报（动态键、整块读、跨文件封装了 useRoute） | 当次打印 warning + `WcPageEntry.query` 显式声明逃生口 |
| `route.params.X` 无对应 path 段 | 只警告、不自动改 path（URL 契约是人工决定）；文档指路 `route.query` / props |
| query 值不是字符串 | `resolve()` 里收口（`String(value)` / 数组元素 string 化 / `null`/`undefined` 丢弃） |
| 同名 prop 页面回归 | 探测时与 props 合并（同名 prop 类型优先，不产生重复项）；`resolveProps` 对声明过的 prop 从两个通道取值 |
| `sameLocation` 计入 query 导致历史条目变多 | 这是正确行为（query 是页面状态的一部分）；同步更新既有断言 |

## Migration

- manifest：新增可选字段，**旧产物 / 旧 runtime / 旧 agent-server 均不报错**；重新 `pnpm analyze` 即可获得新字段。
- 页面源码：**零改动**（探测是 build-time 的）。
- 宿主接入：**零改动**（`location.query` 已在两条桥里被消费）。

## 实施补记（2026-09-19，落地后回填）

1. **`ManifestParam.description`**（D1 的补丁）：设计里 prompt 要展示「查询参数：keyword(string)：按名称过滤」、`WcPageEntry.query` 也要能写说明，
   而 `ManifestParam` 原本只有 `name` / `type` —— 补一个可选 `description`（向后兼容），`AiPageResult` 相应增加 `paramDescriptions`（AI 只给**已探测到**的参数补文案，不改名字/类型/通道）。
2. **类型推断不走 vue-tsc**（D4 的确认）：`useRoute().query` 的静态类型是 `LocationQuery`（`string | null | (string|null)[]`），展开没有信息量；
   实测「props 声明 > 使用点包装调用 > 兜底字面量 > 恒等比较 > string」的启发式足够，且符合「本地先定稿」原则。
3. **单遍扫描**（D3 的细化）：原设计是两遍（先建绑定表再找访问点），实测会让**解构键**的 hits 顺序跑到源码顺序之前（manifest 可读性差）。
   改为单遍 DFS（访问声明节点时 bind、访问其子表达式时 access）→ hits 顺序 = 源码里首次被读到的顺序；代价是要求**绑定先于使用**
   （`const route = useRoute()` 在读取之前），已写进 analyzer README 的已知限制。
4. **解构 / 别名不算「整块读」**：`const q = route.query` / `const { x } = route.query` 由 bind 处理，不再误报「无法枚举键」；
   只有 `{ ...route.query }`、`Object.keys(route.query)`、`route.query[key]` 才出诊断。
5. **两条渲染模式的最后一公里已实测**（浏览器，非单测）：
   - 宿主直连：`__waHostRuntime.navigate({ tag:'datasource-admin', params:{ keyword:'库' } })` → 真实 URL `#/datasources?keyword=%E5%BA%93`、
     页面读 `route.query.keyword` 生效（5 行 → 3 行）；
   - 容器：`__waRuntime.navigate(...)` 同上 → 内存 router 的 query 让面板内页面同样读到（shadow root 内 3 行）。
6. **附带发现（未修，超出本变更范围）**：`navigation.ts` 用 `crypto.randomUUID()` 生成 `navId`，而 `randomUUID` 只在**安全上下文**（https / localhost）可用 ——
   用局域网 IP 或 `host.docker.internal` 这类 http 源访问时导航会抛 `crypto.randomUUID is not a function`。本次改动未触碰该行，建议单开一个变更修（例如兜底一个随机 id）。
7. **二轮收口（2026-09-19）——「显式 `query` 是可选的」口径 + 说明收口**：
   - `WcPageEntry.query` / `ResolvePageParamsOptions.explicit` 类型由 `ManifestParam[]` 收窄为 `Array<Omit<ManifestParam, 'in'>>`：
     装配时本来就强制 `in: 'query'`，之前写 `in: 'path'` 会被静默改写（现在类型上直接禁掉）。
   - 参数 `description` 只取「声明处最近注释的**第一行**」（`routeScan.ts` 的 `firstLine`）：`description` 会进 agent 的 system prompt，
     多行 JSDoc 的续行常是开发者向说明（如"清单声明可选"），不该出网；要写完整业务口径就用页面条目的 `query` 覆盖。
   - 诊断按通道指路：params 通道的「无法枚举键」改为「清单 `path` 补 :段位 / 页面改读 `route.query.x`」（原来指向 `WcPageEntry` 里不存在的 `params` 声明字段）；
     并新增「显式声明与 path 段同名 → 会下发双通道两条入参」告警。
   - 文档口径统一：analyzer / demo-app README、`PROJECT.md` §6.7.1.1、`docs/analyzer-type-resolution.md`、`.changeset` 都明确写出
     「探测能拿到的键不必声明；只有动态键 / 整块读 / 跨文件封装才必须写」。
   - 验证：`pnpm --filter @webassistant/analyzer test` 39 例全绿（新增 params 通道文案 + 双通道告警 + 多行 JSDoc 首行断言，fixture `ParamsRestPage.vue`）；
     demo 工程重跑 `pnpm analyze` → **manifest 零结构差异、零告警**（本地探测结果与产物一致，AI 字段因缓存不变）。
