# analyzer-route-inputs — 页面入参的静态探测与通道标记

## ADDED Requirements

### Requirement: 探测页面源码里的路由查询参数

analyzer SHALL 在不执行页面代码的前提下，从页面源码里探测「读 `route.query` 的键」，并把它们写进 `manifest.pages[].params`（`in: 'query'`）。
探测 MUST 覆盖：`useRoute()` 绑定名上的 `route.query.x`、`route.query['x']`、`` route.query[`x`] ``、
`const { query } = useRoute()`（含 `{ query: q }` 别名）后的 `query.x`、`const { x } = route.query`（含 `{ x: alias }` 重命名）解构、
内联 `useRoute().query.x`，以及模板里 `$route.query.x` / 已绑定路由变量名上的 `.query.x`。

#### Scenario: computed 里读 query 名

- **WHEN** 页面写 `const ruleName = computed(() => String(route.query.name || ''))`，且 `wc.pages.json` 的 `path` 为 `/datasources`（无 `:name`）
- **THEN** manifest 的 `params` 含 `{ name: 'name', type: 'string', in: 'query' }`

#### Scenario: 别名与解构写法

- **WHEN** 页面写 `const { query: q } = useRoute()` 并用 `q.tab`，或写 `const { keyword: kw } = route.query`
- **THEN** `tab` / `keyword` 都被探测为 `in: 'query'` 的参数

#### Scenario: 无 `useRoute()` 绑定的页面

- **WHEN** 页面从不调用 `useRoute()`，只在无关对象上用 `.query.` 前缀（如 `const http = { query: { a: 1 } }`）
- **THEN** 不产生任何 query 参数（不误报）

### Requirement: 查询参数的类型推断

analyzer SHALL 为每个探测到的 query 键推断类型，优先级为：同名 `defineProps` 已声明的类型 > 使用点的包装调用
（`String` / `Number` / `parseInt` / `parseFloat` / `Boolean`）> 兜底字面量（`|| 1` → `number`、`|| ''` → `string`、`|| true` → `boolean`）> 恒等比较（`=== 'true'` → `boolean`）> 缺省 `string`。

#### Scenario: 包装调用决定类型

- **WHEN** 页面写 `const page = computed(() => Number(route.query.page || 1))`
- **THEN** 该参数类型为 `number`

#### Scenario: props 类型优先

- **WHEN** 页面同时声明 `defineProps<{ keyword?: string }>()` 并读 `route.query.keyword`
- **THEN** 该参数类型取 `string`（来自 props 声明），且不产生第二个同名参数

### Requirement: 入参合并与显式声明逃生口

analyzer SHALL 把「`path` 正则提取的路径参数」与「源码探测的 query 参数」以及「`wc.pages.json` 页面条目的显式 `query` 声明」合并，
去重键为 `(name, in)`：同名但通道不同 MUST 保留两条（页面可能两种读法都成立）；显式声明与探测同名同通道时 MUST 以显式声明的 `type` / `description` 为准。
页面条目的 `query` 声明通道固定为 `query`（声明里写 `in` 无效，类型上已禁），且整体是**可选**的逃生口：
只有探测盲区（动态键 / 整块读 / 跨文件封装 `useRoute()`）才必须写。

#### Scenario: 显式声明覆盖探测结果

- **WHEN** 页面条目声明 `"query": [{ "name": "keyword", "type": "string", "description": "按名称过滤" }]`，页面源码也读 `route.query.keyword`
- **THEN** manifest 里只有一条 `{ name: 'keyword', type: 'string', in: 'query', description: '按名称过滤' }`

#### Scenario: 没有显式声明也能拿到参数

- **WHEN** 页面源码读 `route.query.keyword`，而页面条目**没有**写 `query` 声明
- **THEN** manifest 仍含 `{ name: 'keyword', type: 'string', in: 'query' }`（声明只用于补盲区或覆盖说明）

#### Scenario: 同名双通道

- **WHEN** `path` 为 `/users/:id`，页面同时读 `route.params.id` 与 `route.query.id`
- **THEN** manifest 的 `params` 同时含 `{ name: 'id', type: 'string' }`（path）与 `{ name: 'id', type: 'string', in: 'query' }`

#### Scenario: 显式声明与 path 段同名

- **WHEN** 页面条目在 `query` 里声明 `id`，而 `path` 为 `/users/:id`
- **THEN** `params` 保留两条（path + query），并打印「会同时下发 path 与 query 两条同名入参」的警告

### Requirement: 参数说明只取源码注释的第一行

analyzer SHALL 用 query 键「声明处最近注释的**第一行**」作为 `description`；
MUST NOT 把该注释的续行写进 manifest —— `description` 会进 agent 的 system prompt，续行常是开发者向说明。
需要更完整的业务口径时，SHALL 由页面条目的 `query` 声明覆盖（显式优先）。

#### Scenario: 多行 JSDoc

- **WHEN** 探测到的 query 键上方是多行 JSDoc，第一行是摘要、续行是「清单声明可选」这类开发者向说明
- **THEN** manifest 里该参数的 `description` 只含第一行

### Requirement: 无法交付的入参必须给出诊断

analyzer SHALL 对「读 `route.params.X` 但 `path` 里没有 `:X`」的情况打印警告（vue-router 会丢弃这类参数），
并 MUST NOT 自动改写 `path`；对「整块读 `route.query`」「动态键 `route.query[key]`」这类无法枚举的 **query** 情况，
SHALL 打印提示建议走页面条目的 `query` 显式声明；对 **params** 通道的同类情况，
SHALL 指路「在清单的 `path` 里补 :段位」或「让页面改读 `route.query.x`」，
MUST NOT 建议声明 `params` 字段（`WcPageEntry` 没有该字段）。

#### Scenario: params 与 path 不一致

- **WHEN** 页面读 `route.params.legacyId`，而 `wc.pages.json` 的 `path` 为 `/datasources`
- **THEN** analyze 打印包含 `legacyId` 的 `⚠️` 警告，且 manifest 不为它生成参数

#### Scenario: 整块读 query

- **WHEN** 页面写 `watch(() => ({ ...route.query }), ...)` 或 `Object.keys(route.query)`
- **THEN** analyze 打印「无法枚举 query 键，请用显式声明」类警告

#### Scenario: params 通道的「无法枚举」诊断不指向不存在的字段

- **WHEN** 页面写 `const { ...rest } = route.params` 或 `route.params[key]`
- **THEN** 警告包含「无法枚举键」与 `route.params`，且不含「用 params 显式声明」这类指路
