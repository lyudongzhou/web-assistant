# runtime-route-input-channels — 入参按通道下发到页面

## ADDED Requirements

### Requirement: 按 manifest 的通道标记分流 agent 入参

runtime SHALL 在解析导航目标时按 `route.params[].in` 分流 agent / 宿主传入的 `params`：
标记为 `query` 的键 MUST 进入 `RuntimeLocation.query`（值收口为 `string` / `string[]`），其余键 MUST 保持进入 `params`（既有行为）；
未在 manifest 声明的键 MUST 保持旧行为（留在 `params`）。显式传入的 `target.query` MUST 优先级最高。

#### Scenario: query 通道参数送达 location.query

- **WHEN** 某路由的 `params` 为 `[{ name: 'name', type: 'string', in: 'query' }]`，agent 导航 `{ tag, params: { name: '订单库' } }`
- **THEN** `location.query` 为 `{ name: '订单库' }`、`location.params` 不含 `name`、`location.path` 不带 `?`

#### Scenario: 非字符串值收口

- **WHEN** agent 传 `{ page: 2 }` 且该键标记为 `query`
- **THEN** `location.query.page === '2'`（数组则为 `string[]` 且元素字符串化）

#### Scenario: 双通道同名键

- **WHEN** `id` 同时以 path 与 query 两条声明存在，agent 传 `{ id: 7 }`
- **THEN** `location.params.id` 与 `location.query.id` 都有值，`route.params` / `route.query` 两种页面读法都成立

### Requirement: 查询参数变化视为一次新导航

runtime SHALL 在「同一 tag、同一 params」但 query 不同的两次导航之间判定为**不同**导航（不得判为 duplicated），
以便历史回退能回到上一个 query 状态。

#### Scenario: 同页不同 query 产生新历史条目

- **WHEN** 连续 `commit({ tag: 'datasource-admin', params: { keyword: 'a' } })` 与 `commit({ tag: 'datasource-admin', params: { keyword: 'b' } })`（keyword 均标记 query）
- **THEN** `historySize` 增加（两条历史），`nav.back()` 回到 `query.keyword === 'a'`

### Requirement: 查询参数可作为声明过的 prop 下发

`resolveProps` SHALL 对路由声明的 props 从 `params` 与 `query` 两个通道取值（`params[name] ?? query[name]`），
但 MUST NOT 把「页面未声明为 prop 的 query 键」写进下发 props（避免污染元素属性）。

#### Scenario: 声明过的 prop 拿到 query 值

- **WHEN** 路由 `props` 含 `keyword`，`query` 含 `keyword: 'x'`
- **THEN** 下发 props 里 `keyword === 'x'`

#### Scenario: 未声明的 query 键不下发

- **WHEN** `query` 含 `id: '7'`，但路由 `props` 未声明 `id`
- **THEN** 下发 props 不含 `id`
