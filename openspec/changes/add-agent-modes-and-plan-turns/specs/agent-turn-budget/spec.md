## ADDED Requirements

### Requirement: 步数即将用尽时提醒模型收尾

系统 MUST 在单轮迭代达到上限前一步时，向**当次**模型请求注入一条收尾提醒（仅影响该次请求，不写入对话轨迹），要求模型优先调用收尾工具结束本轮。

#### Scenario: 倒数一步收到提醒

- **WHEN** 单轮上限为 N，模型请求进入第 N-1 次迭代
- **THEN** 该次请求的消息中包含一条收尾提醒（系统级），且 runtime 的对话轨迹不因该提醒新增消息

#### Scenario: 未到倒数一步不打扰

- **WHEN** 模型请求处于第 1..N-2 次迭代
- **THEN** 请求中不包含该收尾提醒

### Requirement: 步数用尽表现为「已暂停」而非失败

当单轮迭代上限被用尽时，系统 MUST 不发 `chat.error`，而是以正常结束的方式告知用户本轮已暂停并可继续。

#### Scenario: 打满上限后用户看到暂停提示

- **WHEN** 模型在单轮内用尽全部迭代仍未收尾（未调用任何收尾工具）
- **THEN** 服务端下发 `chat.done`（含步数与耗时）与一条助手文本说明「本轮已暂停、可回复继续」，且本会话的 run 状态不是 `failed`

#### Scenario: 暂停后可继续

- **WHEN** 上一条暂停提示下发后用户发送「继续」
- **THEN** 服务端接受该消息并起新一轮，新一轮仍带暂停前的对话上下文

### Requirement: 收尾工具保证一轮正常结束

系统 MUST 提供 `finish_turn({ summary, done?, remaining?, doneAll? })` 工具，其调用 MUST 使本轮 run 以 `completed` 收尾并把进度结构化记录到会话。

#### Scenario: 主动收尾

- **WHEN** 模型在任意一轮调用 `finish_turn({ summary: '已打开列表页' })`
- **THEN** 本轮以 `completed` 收尾，且不产生任何工具错误

#### Scenario: 收尾文本不与结构化载荷重复

- **WHEN** 本轮以 `propose_plan` 或 `ask_user` 收尾
- **THEN** 服务端不额外补发一条内容重复的助手文本（计划 / 问题以结构化消息呈现）

### Requirement: 单轮上限可配置且默认提高

单轮迭代上限 MUST 可通过环境变量（`MAX_AGENT_STEPS`）配置，且默认值 MUST 不小于 12。

#### Scenario: 默认上限

- **WHEN** 未设置 `MAX_AGENT_STEPS`
- **THEN** 单轮迭代上限为 12

#### Scenario: 环境变量覆盖

- **WHEN** 设置 `MAX_AGENT_STEPS=3`
- **THEN** 单轮在第 3 次迭代后按「已暂停」收尾（不产生 `chat.error`）
