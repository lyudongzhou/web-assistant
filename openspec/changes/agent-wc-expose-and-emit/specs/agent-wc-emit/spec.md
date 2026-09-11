## ADDED Requirements

### Requirement: 页面 emit 事件回传 agent

页面通过 Vue `defineEmits` 声明的事件 **MUST** 经 runtime → ws `page.emit` → agent-server session 回传，agent 能作为通知面参考。

#### Scenario: 页面派发已声明事件
- **WHEN** 当前页面 `defineEmits` 声明了 `selection-change`，页面触发该事件并带 payload
- **THEN** runtime 捕获并转发 `page.emit { tag, event: 'selection-change', payload }`，agent-server 记入该会话的 observations

#### Scenario: 未声明事件
- **WHEN** 页面派发的事件不在 manifest `emits[]` 白名单内（且未启用全量监听）
- **THEN** runtime 不转发，或仅在启用全量监听时转发（由实现决定），agent 不依赖未声明事件

### Requirement: manifest 记录页面 emit 合同

analyzer **MUST** 从页面源码静态解析 `defineEmits` 声明的事件名（与可选的 JSDoc/载荷类型描述），写入 manifest v2 的 `emits[]`，供 agent 规划。

#### Scenario: 静态解析 defineEmits
- **WHEN** analyzer 处理含 `defineEmits<{ 'selection-change': [rows: unknown[]] }>` 的页面
- **THEN** 输出 `emits: [{ name: 'selection-change', description?: '...' }]`（载荷类型 MVP 可省略）

#### Scenario: 无 emit 声明
- **WHEN** 页面没有 `defineEmits`
- **THEN** manifest 中该页 `emits` 省略或为空数组

### Requirement: 会话记录与可等待

agent-server **MUST** 把收到的 `page.emit` 事件纳入会话记录，并（可选增强）支持 `wait_for_observation` 的 `contains` 匹配。

#### Scenario: 事件进入会话上下文
- **WHEN** agent-server 收到 `page.emit`
- **THEN** 该事件按 tag 记入 session（与 observations 同构），后续 prompt 构建可引用

#### Scenario: 事件可被等待（增强）
- **WHEN** agent 用 `wait_for_observation({ match: { contains: '...' } })` 等待某事件语义
- **THEN** 命中则立即返回，超时（默认 10s 封顶）返回超时结果
