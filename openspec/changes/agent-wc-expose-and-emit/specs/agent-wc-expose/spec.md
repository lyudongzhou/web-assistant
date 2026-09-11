## ADDED Requirements

### Requirement: agent 可调用页面 expose 方法

页面组件通过 `defineExpose` 暴露的方法，agent **MUST** 能通过 `call_page_method` 工具调用，并取得 JSON 可序列化的返回值或错误。

#### Scenario: 调用当前页面已暴露的方法
- **WHEN** 当前页面 manifest 的 `exposes` 声明了方法 `refresh`，agent 调用 `call_page_method({ name: 'refresh' })`
- **THEN** chat-client 从当前页 element.exposed 取到并执行 `refresh`，成功时回 `tool.result { ok: true, data }`

#### Scenario: 调用未声明/不存在的方法
- **WHEN** agent 调用的 `name` 不在页面 `exposes` 声明内，或当前页 element.exposed 中不存在该键
- **THEN** 返回 `tool.result { ok: false, error }`，error 说明「未声明/不存在」，且该结果进入会话历史

#### Scenario: 调用超时或断线
- **WHEN** 方法执行超过工具超时（默认 8s）或 ws 断线
- **THEN** 按 RPC 超时/断线语义返回 `ok: false, timedOut: true`，不悬挂 pending Promise

### Requirement: runtime 透出页面 exposed 能力清单

runtime **MUST** 能在任意时刻提供「当前页面 expose 的方法 key 列表」，并在页面切换后广播变化。

#### Scenario: 页面切换后能力清单更新
- **WHEN** `applyNavigation` 完成、新页面渲染就绪
- **THEN** runtime 广播 `page-exposed-changed { tag, keys }`，keys 为当前页 `element.exposed` 的键列表（仅 key，不含函数）

#### Scenario: 查询指定页 exposed
- **WHEN** 宿主调用 `getPageExposed(tag)`，且该 tag 已渲染
- **THEN** 返回该页 element.exposed 对象；未渲染或不存在时返回 `null`

### Requirement: manifest 记录页面 expose 合同

analyzer **MUST** 从页面源码静态解析 `defineExpose` 的 key 与 JSDoc 描述，写入 manifest v2 的 `exposes[]`，供 agent 规划与调用。

#### Scenario: 静态解析 defineExpose
- **WHEN** analyzer 处理含 `defineExpose({ refresh, setKeyword })` 的 `<script setup>` 页面
- **THEN** 输出 `exposes: [{ name: 'refresh', description?: '...' }, { name: 'setKeyword', ... }]`，不解析函数体

#### Scenario: 无 expose 声明
- **WHEN** 页面没有 `defineExpose`
- **THEN** manifest 中该页 `exposes` 省略或为空数组，agent 看不到任何可调用方法
