## ADDED Requirements

### Requirement: 计划提议以收尾工具产出

系统 MUST 提供 `propose_plan({ summary, steps[] })` 工具，其调用 MUST 使本轮 run 以 `completed` 正常收尾（而非报错），并把计划结构化下发（`chat.plan`）与存入会话。

#### Scenario: 提交计划后本轮正常结束

- **WHEN** 模型调用 `propose_plan({ summary: '对比三张数据源', steps: [{ title: '打开数据源列表' }, { title: '逐个查看配置' }] })`
- **THEN** 本轮 run 状态为 `completed`（不是 `failed`），服务端下发一条 `chat.plan`（含 `planId`、`summary`、`steps`），且 `session.plan.steps` 与之一致

#### Scenario: 计划步骤编号稳定

- **WHEN** `chat.plan` 已下发
- **THEN** 每个步骤在会话内拥有稳定标识（用于后续进度标记），后续轮次的进度更新以该标识对应

#### Scenario: 计划不会重复下发

- **WHEN** 同一轮中模型多次调用 `propose_plan`
- **THEN** 只有最后一次的计划生效并下发（早前的计划被覆盖，不产生多条互斥卡片）

### Requirement: 计划需用户确认后进入执行

系统 MUST 等到用户确认才允许执行计划；确认通过 `chat.send` 携带该计划的 `planId` 表达，且 MUST 记录确认时间（`session.plan.approvedAt`）。

#### Scenario: 确认后计划状态变为已批准

- **WHEN** 客户端发送 `chat.send({ text: '开始执行', planId: '<当前计划 id>' })`
- **THEN** `session.plan.approvedAt` 被设置，且该轮可正常操作页面

#### Scenario: 确认已过期的计划不生效

- **WHEN** 客户端发送的 `planId` 与会话当前计划不一致（如已被重新规划）
- **THEN** 服务端不误批准当前计划，并以可读文本告知用户计划已更新（要求重新确认）

### Requirement: 分轮推进与进度交接

计划执行 MUST 支持跨多轮：每一轮推进计划的若干步骤并以 `finish_turn` 收尾交接进度；系统 MUST 把「当前计划与已完成/剩余步骤」注入下一轮的模型上下文。

#### Scenario: 一轮做完就交接

- **WHEN** 计划已批准，模型完成前两步后调用 `finish_turn({ summary: '已打开列表并记录配置', done: ['step-1','step-2'], remaining: ['step-3'] })`
- **THEN** 本轮以 `completed` 收尾，会话中对应步骤被标记完成，剩余步骤保留

#### Scenario: 下一轮上下文含进度

- **WHEN** 用户在同一连接内发送「继续」
- **THEN** 该轮注入的系统提示包含当前计划的摘要、已完成步骤与剩余步骤，模型无需用户重述任务

#### Scenario: 全部完成时收尾并标记计划结束

- **WHEN** 模型调用 `finish_turn({ doneAll: true, summary: '三张数据源已对比完成' })`
- **THEN** 本轮以 `completed` 收尾，计划被标记为已完成（不再要求用户确认或继续）

### Requirement: 重新规划

系统 MUST 允许用户放弃当前计划并要求重新规划。

#### Scenario: 重新规划产生新计划

- **WHEN** 计划处于待确认状态时，用户发送「重新规划」或新的任务描述
- **THEN** 服务端清除当前计划的批准状态，模型可再次调用 `propose_plan`，新计划的 `planId` 与旧的不同（旧卡片按过期处理）
