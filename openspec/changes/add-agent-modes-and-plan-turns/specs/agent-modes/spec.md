## ADDED Requirements

### Requirement: 三种模式的语义与默认值

系统 MUST 支持 `act`（直接执行）、`plan`（先出计划）、`auto`（自动判定）三种模式；默认模式为 `auto`，且默认值 MUST 可由环境变量（`MODE_DEFAULT`）覆盖。模式请求值属于会话，MUST 随连接销毁。

#### Scenario: 默认 auto

- **WHEN** 客户端发送 `chat.send` 但未携带 `mode`
- **THEN** 服务端按会话当前模式（初始为 `MODE_DEFAULT`，缺省 `auto`）处理该轮

#### Scenario: 显式模式立即生效

- **WHEN** 客户端发送 `chat.send` 且携带 `mode: 'act'`
- **THEN** 该轮以 `act` 生效（`session.mode.effective === 'act'`，`decidedBy === 'user'`），且该请求值在同连接后续轮次中保持

### Requirement: auto 模式的三层判定

`auto` 模式下系统 MUST 按「显式 > 启发式 > 模型自判」的顺序判定生效模式：请求未显式指定时先跑启发式（纯函数），启发式能定则定，不能定则采用计划倾向的提示让模型自选。

#### Scenario: 多步信号触发计划

- **WHEN** 用户在 `auto` 模式下发消息「先看订单列表，然后把三张数据源逐个对比，最后出一份结论」
- **THEN** 生效模式为 `plan`，且 `decidedBy === 'heuristic'`，判定理由随 `chat.mode` 下发

#### Scenario: 单页明确请求直接执行

- **WHEN** 用户在 `auto` 模式下发消息「打开用户列表」（命中单一页面关键词且无缺参）
- **THEN** 生效模式为 `act`，`decidedBy === 'heuristic'`

#### Scenario: 无法判定时交给模型

- **WHEN** 用户消息既不命中多步信号也不命中单一页面关键词
- **THEN** 生效模式为 `plan`（计划倾向），`decidedBy === 'model'`，模型可在本轮直接操作页面（不被门禁拦）或在需要多步时先调用 `propose_plan`

### Requirement: 生效模式对用户可见

系统 MUST 在每一轮开始时通过 `chat.mode` 下发生效模式、请求模式、判定来源与理由，使 UI 能显示「当前模式」以及它是怎么被决定的。

#### Scenario: 每轮下发模式

- **WHEN** 服务端开始处理一轮 `chat.send`
- **THEN** 在该轮任何 `chat.text` / `agent.step` 之前下发一条 `chat.mode`，含 `requested` / `effective` / `decidedBy` / `reason`

### Requirement: plan 模式下未确认计划的操作被硬拦截

`plan` 模式（含 `auto` 判定为 `plan`）且当前会话没有已确认计划时，系统 MUST 阻止 `render` 与 `call_page_method` **实际执行**，并把「如何解锁」作为工具错误返回给模型；该拦截 MUST NOT 使本轮 run 失败，也 MUST NOT 额外消耗模型调用。

#### Scenario: 未确认计划时操作被拦

- **WHEN** 生效模式为 `plan` 且 `session.plan.approvedAt` 为空，模型调用 `render({ tag: 'user-list' })`
- **THEN** 该工具不执行（不产生任何导航），模型收到 `isError` 的工具结果，内容说明需先提交计划并取得用户确认

#### Scenario: 拦截后仍可提交计划

- **WHEN** 上一条被拦截的同一轮里模型接着调用 `propose_plan`
- **THEN** 调用成功，本轮以计划收尾（`completed`），不受前一次拦截影响

#### Scenario: 确认后放行

- **WHEN** 用户在计划卡上确认（`chat.send` 携带 `planId`）后，模型调用 `render`
- **THEN** 工具正常执行

#### Scenario: 门禁可关闭

- **WHEN** 服务端配置 `PLAN_GATE=off`
- **THEN** `plan` 模式下未确认计划的 `render` / `call_page_method` 不再被拦截（仅保留提示）
