# chat-client-host-mode — 面板 host 模式

## ADDED Requirements

### Requirement: runtime 由宿主注入

chat-client SHALL 提供 runtime 构造注入口（`createRuntime`），
host 模式下 runtime MUST 由宿主提供的 `createVueHostRuntime` 构造；chat-client 自身 MUST NOT 依赖 vue-router。

#### Scenario: 宿主注入宿主直连 runtime

- **WHEN** 宿主传 `surface="host"` 与 `createRuntime: ({ initial }) => createVueHostRuntime({ router, app, manifestUrl, initial })`
- **THEN** 面板使用该 runtime 与 agent 通信，导航作用在宿主 router 上

#### Scenario: 未提供注入口时保持容器模式

- **WHEN** 不传 `surface` / `createRuntime`
- **THEN** 行为与现状完全一致（`manifestUrl = {wcBase}/manifest.json`、`assetBase = {wcBase}/dist-ce`、面板内渲染）

### Requirement: host 模式无面板渲染区

`surface: 'host'` 时面板 SHALL NOT 渲染页面容器区域（页面由宿主自身位置渲染），
但仍 MUST 保留对话、错误提示与当前页状态指示。

#### Scenario: 面板不再抢渲染

- **WHEN** host 模式下 agent 打开页面
- **THEN** 面板内不出现容器节点（无 shadow root 挂载点），页面只出现在宿主 `<router-view>`

### Requirement: hasPage 语义

host 模式下 `hasPage` SHALL 表示「当前路由命中页面目录」，而 MUST NOT 再由面板内部渲染区是否渲染 WC 决定。

#### Scenario: 命中页面目录

- **WHEN** 宿主当前路由在 manifest 页面目录内
- **THEN** `hasPage` 为 `true`；离开到非目录路由（如登录页）时为 `false`

### Requirement: 事件与上报通道不变

host 模式 MUST 复用既有通道：导航上报（`page.navigated`）、页面事件（`page.emit`）、
数据快照（`page.data`）、expose 清单（`page.exposed`）、tool RPC（`render` / `call_page_method`）。

#### Scenario: 导航同步给 agent

- **WHEN** host 模式下用户或 agent 改变路由
- **THEN** agent-server 收到 `page.navigated`，`source` 如实区分 `agent` 与 `host`
