# analyzer 跨文件类型解析（vue-tsc 内核）

> 一句话：把 analyzer 从「单文件 + 语法级解析」升级为「vue-tsc 内核 + 跨文件类型解析」，让 manifest 里 `props` / `emits` 载荷 / `exposes` 签名中的自定义类型（`DatasourceVO`、`DatasourceRequest` 等）展开成真实字段结构，再把这份准确结构喂给 AI，只让 AI 补语义。

## 一、需求背景

当前 `@webassistant/analyzer` 生成 manifest 的静态分析是**单文件 + 语法级**：`parseComponent.ts` 用 `@vue/compiler-sfc` 切块、`@babel/parser`（开 typescript 插件）只扫 `<script setup>` 顶层 `defineProps/defineEmits/defineExpose`，**不解析 import、不做类型解析、不碰模板**。

由此产生三个直接后果：

1. **跨文件类型无法展开**。`exposes[].signature` 里 `handleDialogSubmit(data: DatasourceRequest)` 的 `DatasourceRequest` 只是被打印成名字字符串（`serializeTypeName` 的 `TSTypeReference` 分支直接 `return name`），agent 拿到签名后**不知道 `DatasourceRequest` 有哪些字段**，规划调用时只能靠猜、容易幻觉。
2. **props/params/events 常为空**。
   - `props: []` —— 页面用类型写法 `defineProps<{...}>()`（里面的 `DatasourceVO` 退化成 `Object`）或压根没用 `defineProps`。
   - `params: []` —— 路由 `/datasource` 没有 `:id`，`extractParams` 是纯正则。
   - `events: []` —— 页面没写 `defineEmits`，事件只在模板 `@click` 里，分析器看不见。
3. **不能把原始源码直接喂 AI 补全**。原始源码 + 全量 import 图 token 大、内容多易幻觉，违背「本地先定稿、AI 只做语义」的原则。

结论：**先在本地做确定性类型解析，把准确的结构（字段名/类型）锁死后，再把这份「准确结构」喂给 AI**，AI 只回 `description/keywords/exampleQueries`。

## 二、目标 / 非目标

### 目标

- 用 vue-tsc 内核（`@vue/language-core` + `@volar/typescript`）做**完整跨文件类型解析**，把 `DatasourceVO`、`DatasourceRequest` 这类自定义类型展开成 `{ field: type }`。
- 补齐 `props`（`defineProps<{}>` 展开）、`emits` 载荷类型、`exposes` 方法签名里的类型。
- `ai.ts` 输入从「源码」切换为「结构化 PageFacts」，token 下降、杜绝字段级幻觉。

### 非目标

- 不做运行时类型检查（不引入 `vue-tsc --noEmit` 全量报错，只借它的类型解析能力）。
- 不解析 `defineExpose` 函数体（只取签名 + 类型 + JSDoc）。
- 不改 manifest v2 协议字段（`ManifestProp.type` / `ManifestMethod.signature` 仍是 `string`，只是从名字变成展开文本，向后兼容）。

## 三、技术方案

### 3.1 技术栈（即 vue-tsc 自己用的那套）

| 组件 | 作用 |
|---|---|
| `@vue/language-core` → `createVueLanguagePlugin` | 把 `.vue` 编译成虚拟 TS（script setup + 模板类型推断），让 TS 看懂 Vue SFC |
| `@vue/language-core` → `createParsedCommandLine` | 读宿主 `tsconfig.json`，解析 `paths`/`extends` 别名 + `vueCompilerOptions` |
| `@volar/typescript` → `proxyCreateProgram` | 包装 `ts.createProgram`，让 `.vue` 文件能进 program 被 checker 解析 |
| `typescript` → `checker.getTypeAtLocation` | 拿到节点真实类型，展开 interface / type 别名 / 枚举 |

### 3.2 流水线（本地优先，AI 只做语义）

```
页面 .vue + 依赖的 .ts/.vue
        │ ① 本地确定性分析（vue-tsc 内核做跨文件类型解析）
        ▼
PageFacts（准确的结构骨架，字段名/类型已锁死）
  - props / params / events / dataSources / 可编辑字段
  - exposes[].signature 里的 DatasourceVO、DatasourceRequest 已展开成 { name: string; host: string; ... }
        │ ② 只把 PageFacts（很小、很准）喂给 AI
        ▼
manifest v2（结构字段全部来自①，语义字段 description/keywords/exampleQueries 来自②）
```

### 3.3 关键决策

- **D1：分层不推翻**。`parseComponent.ts` 继续用 babel 做轻量的「找到 `defineXxx` + 拿 JSDoc 描述」，新增 `typeResolver.ts` 只做「类型定稿」，两者叠加——babel 拿 JSDoc 最方便，checker 拿类型最准。
- **D2：只展开项目内类型，但外部泛型不「短路」**。用 `symbol.declarations[0].getSourceFile()` 判断声明是否在 `node_modules`：
  - 项目内类型（含 `node_modules` 里软链进来的 workspace 包，如 `@unicom/ontology-api` → `packages/api`，realpath 不在 `node_modules`）→ 递归展开字段 `{ field: type }`；
  - 外部**非泛型**类型（`AxiosResponse`、`Record<string, string>`）→ 只打印名字，不递归；
  - 外部**泛型实例化**（`Promise<T>` / `Set<T>` / `AxiosResponse<T>`）→ 保留名字但**继续展开类型参数**：`Promise<DatasourceVO>` → `Promise<{ id: number; ... }>`。否则整棵子树被压成一个名字，里面的项目内类型永远看不到字段（`setFilter(patch: Partial<DatasourceFilter>) => Promise<DatasourceFilter>` 就是这么退化成裸名字的）；
  - 外部 **mapped 类型**（`Partial<T>` / `Required<T>` / `Readonly<T>` / `Pick<T, K>` / `Omit<T, K>`）→ 类型参数里有项目内类型时**按对象展开**：`Partial<DatasourceFilter>` → `{ keyword?: string; datasourceType?: string; status?: string; testStatus?: string }`。`getPropertiesOfType` 已经带上 `Optional` 标记，比 `Partial<{...}>` 更贴近「照着实参传」的用途；类型参数全在项目外时（`Record<string, string>`）仍只打印名字。
  加深度上限 + 环检测，防递归类型爆炸。
- **D6：注解偏移要收敛到「类型节点」**。`parseComponent` 传进来的偏移是**类型注解节点的起点**，而这个起点常常同时是内部标识符的起点（`Foo[]` 的 `Foo`、`Partial<X>` 的 `Partial`）。`findNodeAt` 取的是最深节点 → 拿到 Identifier → `getTypeAtLocation(Identifier)` 返回的是**符号声明类型**：`Partial<X>` 退化成泛型声明形态 `Partial<T>`、`Foo[]` 丢掉 `[]` 只剩元素类型（非泛型单名恰好「声明类型 == 实例化类型」，所以一直没暴露）。`locate()` 因此把节点向上收敛到「起点相同的最外层 `ts.isTypeNode`」；值位置的标识符（`defineExpose({ refresh })` 的 `refresh`、形参名 `patch`）父节点不是类型节点，原样不动，函数签名路径不受影响。
- **D3：tsconfig 定位与降级**。默认从 `wc.pages.json` 同目录（项目根）找 `tsconfig.json`，允许 `--tsconfig` 覆盖；找不到或 vue 语言失败时**降级回现有 babel 行为**，不破坏没用 vue-tsc 的宿主项目。
- **D4：AI 只喂 PageFacts**。`AiPageInput` 的 `source` 换成 `facts`（已展开的 props/params/events/exposes/dataSources），缓存 key 改 hash(facts + path)，facts 变了才重分析。
- **D5：依赖变更**。`typescript` 从 devDependencies → dependencies；新增 `@vue/language-core`、`@volar/typescript`。

### 3.4 首要风险与对策

`.vue` 源码位置 ↔ 虚拟 TS 位置的映射（在哪个 node 上调 `getTypeAtLocation` 才拿得到正确类型）是最大实现风险。

**对策：先写最小可跑 prototype**（一个含 `DatasourceVO` 的 fixture `.vue` + 展开函数），用 `node --test` 验证能正确展开，再铺到 `analyze.ts` 全流程。

## 四、实施计划

### 1. 依赖准备
- [x] 1.1 `packages/analyzer/package.json`：`typescript` 移到 dependencies，新增 `@vue/language-core`、`@volar/typescript`

### 2. typeResolver 原型（先验证映射风险）
- [x] 2.1 新增 `packages/analyzer/src/typeResolver.ts`：`createParsedCommandLine` 读 tsconfig + `createVueLanguagePlugin` + `proxyCreateProgram` 建 program
- [x] 2.2 实现 `serializeType(checker, type, node, depth)`：基本类型 / 数组 / 元组 / 联合 / 枚举 / interface / type 别名展开成 `{ field: type }`；项目内类型递归、node_modules 类型只打印名字；深度上限 + 环检测
- [x] 2.3 新增 fixture（`DatasourceVO`/`DatasourceRequest` 的 `.ts` + import 它们的 `.vue`）+ prototype 单测，验证 `(data: DatasourceRequest)` → `(data: { name: string; host: string; ... })`

### 3. 接入 analyzer
- [x] 3.1 `parseComponent.ts`：`extractProps` 类型写法、`extractExpose` 签名、`extractEmits` 载荷走 typeResolver 展开
- [x] 3.2 `analyze.ts`：`parseComponent` → `resolveComponentTypes` → 组装 PageFacts → 喂 AI；tsconfig 定位与 `--tsconfig` 选项

### 4. AI 输入切换
- [x] 4.1 `ai.ts`：`AiPageInput.source` → `facts`；`buildPrompt` 渲染 facts JSON，prompt 只让 AI 回 `description/keywords/exampleQueries` + 补缺 description 的字段/方法；缓存 key 改 hash(facts + path)

### 5. 测试 & 验收
- [x] 5.1 `pnpm build && node --test`（analyzer 单测：类型展开、node_modules 不递归、降级路径）
- [x] 5.2 `pnpm analyze` 跑通，核对 manifest：`exposes[].signature` 从 `(data: DatasourceRequest)` → `(data: { ... })`，`props` 从 `[]` → 展开字段
- [x] 5.3 `pnpm -r typecheck` 通过（含新增依赖）

### 6. 文档
- [x] 6.1 `packages/analyzer/README.md` 补类型解析能力与降级说明；`PROJECT.md` §6.7 补 vue-tsc 内核说明

## 七、补记：外部泛型包装的项目内类型（2026-09-10）

**症状**：宿主页面 `views/datasource/index.vue` 的 manifest 里，`createDatasource(data: DatasourceRequest)` 展开成了 20 个字段，
但 `setFilter(patch: Partial<DatasourceFilter>) => Promise<DatasourceFilter>` 和 `openCreateDialog(preset?: Partial<DatasourceRequest>)`
都只有裸名字 —— agent 不知道该传哪些字段。

**根因**：`Partial<T>` / `Promise<T>` 的别名声明在 TS lib（`node_modules/typescript/lib/lib.es*.d.ts`），被 `isProjectType` 判为外部，
`serializeTypeNode` 直接 `return typeName(type)`，**不递归类型参数** → `DatasourceFilter` 进不到展开分支。数组/元组分支因为排在
`isProjectType` 之前且会 `recurse(element)`，所以 `DatasourceVO[]` 反而是好的；泛型引用缺的就是这条分支。

**改动**（`typeResolver.ts`）：

1. 抽出 `expandObjectProperties()`（项目内类型 / mapped 类型共用）。
2. 新增分支（在数组 / 元组之后、外部兜底之前）：
   - `isMappedWithProjectArgument()` —— mapped 类型且 `aliasTypeArguments` 含项目内类型 → 按对象展开；
   - `typeArgumentsOf()` —— `ObjectFlags.Reference` 且 `checker.getTypeArguments()` 非空 → `裸名字<展开后的参数>`（`bareTypeName()` 取名字）。
3. `locate()` 增加 `climbToTypeNode()` —— 修「注解偏移落在类型名标识符上」导致 `Partial<X> → Partial<T>`、`Foo[] → Foo` 的降级。

**效果**（实测同页 manifest）：

| 源码 | 改前 | 改后 |
|---|---|---|
| `setFilter(patch: Partial<DatasourceFilter>): Promise<DatasourceFilter>` | `(patch: Partial<DatasourceFilter>) => Promise<DatasourceFilter>` | `(patch: { keyword?: string; datasourceType?: string; status?: string; testStatus?: string }) => Promise<{ keyword: string; datasourceType: string; status: string; testStatus: string }>` |
| `openCreateDialog(preset?: Partial<DatasourceRequest>)` | `(preset?: Partial<DatasourceRequest>) => void` | `(preset?: { datasourceCode?: string; ... }) => void` |
| `defineProps<{ related?: DatasourceVO[] }>()` | `VO_SHAPE`（丢 `[]`） | `VO_SHAPE[]` |
| `options?: Record<string, string>` | `Record<string, string>` | 不变（类型参数无项目内类型） |

**回归**：`packages/analyzer/test/{typeResolver,typeResolution}.test.js` 20 条全绿；fixture `TypeFactsPage.vue` 补了
`Partial<T>` / `Foo[]` / `Promise<T>` 三种形态的 props、emits 载荷与 expose 签名，之前这三条路径没有用例覆盖。

## 八、补记：路由 query 入参探测（2026-09-19）

**症状**：页面可以不声明路由参数、却用 `const ruleName = computed(() => String(route.query.name || ''))` 读入参（列表页的筛选 / 翻页 / 来源标记都走 query）。
`extractParams` 只看 `wc.pages.json` 的 `path` 正则 → manifest 的 `params` 为空 → **agent 的 prompt 里没有这个参数，永远不会传**；
即使猜着传了 `render({ tag, params: { name } })`，它也会落进 `location.params`，而 vue-router 对 path 里没声明的 params
**直接丢弃**（实测 `Discarded invalid param(s) "name"`）→ 页面 `route.query.name` 恒为空。

**根因**：缺的不是「多扫一段源码」，而是**入参通道没有显式化** —— `location.query` 只能由 `path` 里的 `?a=1` 或 `navigationTarget.query` 填，
而 agent 的 render 工具只有 `tag` / `params` / `props`，没有任何一条路能把「路径外键值」送进页面的 `route.query`。

**改动**：

1. **协议**（`protocol/src/manifest.ts` / `wcPages.ts`）：`ManifestParam` 新增 `in?: 'path' | 'query'`（缺省 `path`，**path 参数不写该字段**）与 `description`；
   `WcPageEntry` 新增 `query?: Array<Omit<ManifestParam, 'in'>>` 显式声明逃生口（通道固定 query，声明里写 `in` 没有意义）。
2. **探测**（新增 `analyzer/src/routeScan.ts`）：`scanRouteAccess()` 纯 AST 探测 `useRoute()` 绑定名 / `{ query: q }` 别名 /
   `route.query.x`、`route.query['x']`、`const { x: alias } = route.query`、内联 `useRoute().query.x`、模板 `$route.query.x`；
   类型推断 = 同名 props 类型 > 包装调用 > 兜底字面量 > 恒等比较 > `string`；`resolvePageParams()` 把 path 正则 + 探测 + 显式声明
   按 `(name, in)` 去重合并，并输出「无法枚举」「`route.params.x` 与 path 不一致」诊断。analyzer 与 `vite-plugin-wc`
   共用这一个入口（顺手消掉两份重复的 `extractParams`）。
3. **下发**（`wc-runtime-core`）：`resolve()` 按 `route.params[].in` 把 agent 的 `params` 分流到 `location.query`（值收口 string / string[]）；
   `sameLocation()` 计入 query（query 变化算新导航）；`resolveProps()` 让**声明过的 prop**从 `params ?? query` 取值，
   但不把「未声明的 query 键」写进 props（避免污染元素属性）。容器 memory router 与 host 真实 router 都已带 query，**无需改动**。
4. **prompt**（`agent-server`）：参数按通道分段展示（`路径参数：` / `查询参数：`），并补一条规则句说明 `render` 的 `params` 同时承载两种通道。

**效果**（demo-app 实测）：`DatasourceAdmin.vue`（path `/datasources`，无 `:param`）加了 `route.query.keyword` 过滤后，
manifest 出现 `{ "name": "keyword", "type": "string", "in": "query" }`；agent 只需把 `keyword` 放进 render 的 `params`，
两种渲染模式下页面都能通过 `route.query.keyword` 读到（host 模式真实 URL 出现 `?keyword=…`）。

**回归**：`packages/analyzer/test/routeScan.test.js`（7 条）+ `analyze.test.js` 的查询通道用例 +
`packages/wc-runtime-core/test/routeInputs.test.js`（9 条）+ `agent-server/test/manifest.service.test.ts` 的通道分段用例，全绿。
详见 openspec change `detect-route-query-params`。

**补记（落地后二轮收口）**：

1. **`query` 是可选的**（文档口径统一）：探测能拿到的键不必在 `wc.pages.json` 里写；显式声明只有两个用途 ——
   补探测盲区（动态键 / 整块读 / 跨文件封装）、覆盖说明与类型（显式优先）。实测删掉 demo 的两行声明，
   6 个参数仍在，只是 `sort` / `from` 的说明退回源码注释。
2. **说明只取注释第一行**（`routeScan.ts` 的 `firstLine`）：query 的 `description` 会进 agent 的 system prompt，
   多行 JSDoc 的续行常是开发者向说明（"清单声明可选"之类），不该出网。想写完整业务口径 → 用页面条目的 `query`。
3. **诊断不再指向不存在的字段**：`route.params` 通道的「无法枚举键」改为指路「清单的 `path` 补 `:段位`，或页面改读 `route.query.x`」；
   显式声明与 path 段同名时新增一条「双通道」告警（同名双通道是合法能力，但多半非本意）。
4. **类型收窄**：`WcPageEntry.query` / `resolvePageParams({ explicit })` 由 `ManifestParam[]` 收成 `Array<Omit<ManifestParam, 'in'>>`
   —— 装配时本来就会强制 `in: 'query'`，之前写 `in: 'path'` 会被静默改写。
5. **回归**：`pnpm --filter @webassistant/analyzer test` 39 例（新增「params 通道诊断文案」「显式声明与 path 同名告警」+ 多行 JSDoc 首行断言）；
   在 demo 工程重跑 `pnpm analyze` 后 **manifest 零结构差异、零告警**（探测结果与产物一致）。
