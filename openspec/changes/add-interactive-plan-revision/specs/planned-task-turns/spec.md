## MODIFIED Requirements

### Requirement: 重新规划

系统 MUST 允许用户放弃当前计划并要求重新规划（推倒重来）；同时 MUST 提供**不推倒重来**的修订路径（见「计划的交互式修订」）。
两个入口在界面上 MUST 可区分：`PlanCard` 的「修改计划」走修订，「重新生成计划」走本需求的全量重规划。

#### Scenario: 重新规划产生新计划

- **WHEN** 计划处于待确认状态时，用户点「重新生成计划」（或直接发送新的任务描述）
- **THEN** 服务端清除当前计划的批准状态，模型可再次调用 `propose_plan`，新计划的 `planId` 与旧的不同（旧卡片按过期处理）

## ADDED Requirements

### Requirement: 计划的交互式修订

用户 MUST 能在计划卡上**表达具体修改意见**（而不是一句固定的"重新规划"），且该意见 MUST 作为「对当前计划的修订意图」随本轮 `chat.send` 下发（`revisePlanId` = 当前 `planId`）。
服务端 MUST 把本轮标记为修订轮（`session.planTurn`），并在该轮内**拒绝 `propose_plan`**（以工具错误指引改用 `revise_plan`），使"改计划"不会退化成"换计划"。
修订 MUST 由收尾工具 `revise_plan` 产出，本轮 run MUST 以 `waiting-plan`（正常结束，非 `failed`）收尾并下发更新后的计划卡。

#### Scenario: 用户带修改意见提交修订

- **WHEN** 用户在有计划卡时输入「第 3 步改成导出 CSV，再加一步：把结果同步给张三」并提交（`chat.send({ text, revisePlanId: '<当前 planId>' })`）
- **THEN** 服务端记录本轮为修订轮，注入模型的上下文含「本轮是计划修改 + 用户的修改意见」，且该轮 `chat.done.endedBy === 'revise_plan'`、`session.activeRun.status === 'waiting-plan'`

#### Scenario: 修订轮里不许换计划

- **WHEN** 修订轮中模型调用 `propose_plan`
- **THEN** 该调用不生效（不产生新计划、不推新卡片），模型收到 `isError` 的工具结果，内容指引它改用 `revise_plan` 并回填完整步骤

#### Scenario: 修订结果原地更新同一张卡

- **WHEN** 模型调用 `revise_plan` 且修改被接受
- **THEN** 服务端下发 `chat.plan`，其 `planId` **与修订前相同**、`revision` 比修订前大 1、含 `revisedAt` 与变更摘要 `note`，且 `summary` / `steps` 为修订后的内容

### Requirement: 修订按步骤标识增量合并

`revise_plan` 的入参 MUST 表达"修订后的完整步骤序列"：命中当前计划步骤的 `id` MUST 被视为**原地修改**（保留该步骤的状态，除非显式 `reopen`），未携带 `id` 的步骤 MUST 被视为新增（分配会话内新的稳定标识），当前计划里未出现的步骤 MUST 被视为删除。
入参 MUST 允许调整顺序（以入参顺序为准）。引用了当前计划不存在的 `id` MUST 被拒绝（工具错误），以保证"改了就一定生效"。
合并**之后**的步骤数 MUST 仍受上限约束（`MAX_PLAN_STEPS`）。

#### Scenario: 未改动的步骤保持标识与状态

- **WHEN** 当前计划为 `[step-1(done), step-2(pending), step-3(pending)]`，模型调用 `revise_plan({ steps: [{ id: 'step-1', title: '打开数据源页' }, { id: 'step-2', title: '逐个查看配置' }, { id: 'step-3', title: '导出 CSV 对比' }] })`
- **THEN** 合并后 `step-1` 仍为 `done`，`step-2` / `step-3` 仍为 `pending`，`step-3` 的标题被更新，进度（1/3）不丢失

#### Scenario: 新增步骤取新的稳定标识

- **WHEN** 当前计划为 `[step-1, step-2]`，模型调用 `revise_plan({ steps: [{ id: 'step-1', title: 'A' }, { title: '同步结果给张三' }, { id: 'step-2', title: 'B' }] })`
- **THEN** 新增步骤被插入到入参给定的位置并获得一个既有的其他步骤都不使用的稳定标识（`step-3`），`step-1` / `step-2` 不受影响

#### Scenario: 删除步骤

- **WHEN** 模型调用 `revise_plan` 时省略了当前计划里的某个步骤
- **THEN** 该步骤从计划中移除；若移除的是已完成（`done`）步骤，变更摘要 MUST 明确指出被移除的已完成步骤数（不静默丢进度）

#### Scenario: 重新打开已完成的步骤

- **WHEN** 用户要求改一个已完成的步骤，模型对该步骤传 `reopen: true`
- **THEN** 该步骤状态回落到 `pending`，其余步骤状态不变

#### Scenario: 引用不存在的步骤标识被拒绝

- **WHEN** 模型调用 `revise_plan` 且某个步骤的 `id` 不在当前计划中
- **THEN** 调用失败（`isError` 工具结果，说明原因），计划与会话状态 MUST NOT 被改动，模型可自行修正后重试

#### Scenario: 修订后步骤数仍受上限约束

- **WHEN** 修订后的步骤序列超过 `MAX_PLAN_STEPS`
- **THEN** 调用被拒绝并提示需要收敛步骤数（既有步骤不被改动）

### Requirement: 修订后需重新确认

计划被修订后，MUST 按"用户确认过的是哪一份"重新对齐批准状态：修订前**已批准**（执行中）的计划 MUST 回到 `proposed` 并清空 `approvedAt`（plan 门禁随之重新锁上）；修订前未批准的计划 MUST 保持 `proposed`。
`planId` MUST 保持不变，客户端无需丢弃卡片（不产生 `stale` planId 提示）。
客户端提交修订时携带的 `revisePlanId` 与会话当前计划不一致（过期卡片）时，服务端 MUST NOT 改动当前计划，MUST 以可读文本提示用户在最新计划卡上重新提交。

#### Scenario: 执行中改计划需重新确认

- **WHEN** 计划已批准（`approvedAt` 非空、`status: 'approved'`）时用户提交修订，模型调用 `revise_plan`
- **THEN** 修订后的计划 `status === 'proposed'`、`approvedAt === undefined`，且该轮之后未确认的 `render` / `call_page_method` 会被 plan 门禁拦下

#### Scenario: 待确认计划修订后仍待确认

- **WHEN** 计划未批准时用户提交修订并成功合并
- **THEN** 修订后的计划 `status === 'proposed'`，用户仍需点「开始执行」

#### Scenario: 过期卡片的修订被拒

- **WHEN** 客户端用旧 `planId` 提交修订（会话当前计划已换成另一份）
- **THEN** 服务端不修改当前计划，并回一条文本告知计划已更新、请在最新计划卡上重新提交修改

### Requirement: 计划卡提供修改入口与修订可见性

计划卡 MUST 提供可输入的修改入口（而不是只有一个发送固定文案的按钮）：点击「修改计划」后 MUST 可在卡内输入修改意见并提交/取消；提交 MUST 产生带 `revisePlanId` 的一轮，且 MUST **立即收起输入框**（否则卡片会停在"提交修改"视图，用户看不到「开始执行」）。
计划卡 MUST 同时呈现修订事实（第几版 + 变更摘要），且 MUST 在**已批准态**也保留修改入口（改完回到待确认）。
「重新生成计划」（全量重规划）MUST 仍可作为次要入口存在，与「修改计划」在文案上可区分。

#### Scenario: 卡片内提交修改意见

- **WHEN** 用户点「修改计划」、在卡内输入框写下修改意见并提交
- **THEN** 客户端发送 `chat.send({ text: '<修改意见>', revisePlanId: '<卡片上的 planId>' })`，且该轮结束后卡片内容被服务端下发的修订结果替换

#### Scenario: 提交后收起输入并回到可操作态

- **WHEN** 用户提交修改意见（`chat.send` 带 `revisePlanId`）
- **THEN** 计划卡收起输入框（不再显示「提交修改 / 取消」），显示「正在按你的意见更新计划」；修订结果下发后卡片回到「开始执行 / 修改计划」的按钮态，MUST NOT 停留在输入视图

#### Scenario: 可以看到这是第几版与改了什么

- **WHEN** 收到 `chat.plan` 且其 `revision > 1`
- **THEN** 卡片显示「已修订 · 第 N 版」与变更摘要 `note`

#### Scenario: 执行中的计划也能改

- **WHEN** 计划卡处于已批准（执行中）状态
- **THEN** 卡片仍提供「修改计划」入口；提交修订成功后卡片回到待确认（需重新点「开始执行」）

### Requirement: 过程与计划是两个同构的 panel

过程区与计划卡 MUST 是同一层级的**两个 panel**（`过程` 在上、`计划` 在下），共用同一套壳与折叠逻辑：
分隔线与底纹、折叠头布局（chevron 在最左 + 标题类内容 + 尾部 meta）、**折叠头高度**、字号层级、
悬停反馈、「整行可点」的折叠交互、折叠后在宿主 flex 列里的伸缩行为（`flex: 0 0 auto` 由壳统一给）、
以及折叠状态的实现（同一个 `usePanelOpen`）MUST 来自同一处实现，MUST NOT 各自实现一套。
**折叠的粒度 MUST 一致：收起 = 只剩折叠头一行**。计划 panel 收起时 MUST 连详情（步骤列表 / 变更摘要 / 说明文案）
与动作条（「开始执行 / 修改计划」）一起收起，MUST NOT 留下一条常驻的按钮行；
状态行 MUST 常驻（修订中的提示 / 过程区的「思考中…」折起来也要看得见"正在做什么"）。
计划 panel 的**默认折叠值 MUST 跟随状态**：`proposed`（待确认）MUST 默认展开（要用户做决定，步骤与
「开始执行 / 修改计划」都可见可点）；`approved`（执行中）MUST 默认收起（与过程区一样只剩一行
「计划执行中」+ 目标摘要 + `已完成 N/M`）。状态由 `proposed` 变 `approved` 时 MUST 自动收起，
由 `approved` 回到 `proposed`（如修订回来）时 MUST 自动展开。
详情区 MUST 限高并可内部滚动 —— 步骤可以很多，面板 MUST NOT 把消息区挤没、也 MUST NOT 被压扁到内容溢出。

#### Scenario: 两个 panel 的折叠头同构

- **WHEN** 同一面板里同时出现过程区与计划卡（如一轮刚 propose_plan 完）
- **THEN** 两处的折叠头结构一致（`panel-head > panel-toggle > chev + title + meta`）、**高度一致**、
  折叠行为一致（点整行切换、chevron 方向随状态变化），用户不需要学两套

#### Scenario: 折叠计划 = 只剩一行

- **WHEN** 用户点击计划 panel 的折叠头
- **THEN** 步骤列表、变更摘要、说明文案与动作条（「开始执行 / 修改计划」）一起收起（chevron 变为 `▸`），
  只剩折叠头一行：状态徽标、「已修订 · 第 N 版」、目标摘要与 `已完成 1/3` 计数仍可见

#### Scenario: 点「开始执行」后面板自动收成一行

- **WHEN** 计划从 `proposed` 变为 `approved`（用户点「开始执行」，或服务端下发已批准的计划）
- **THEN** 计划 panel 自动收起成一行（与过程区同高），MUST NOT 继续占着步骤列表与动作条

#### Scenario: 待确认（含修订回来）默认展开

- **WHEN** 计划处于 `proposed`（首次下发，或修订后回落成 `proposed`）
- **THEN** 计划 panel 默认展开，步骤列表与「开始执行 / 修改计划」可见可点

#### Scenario: 换计划回到默认展开

- **WHEN** 服务端下发了另一份计划（`planId` 变化，如用户点了「重新生成计划」）
- **THEN** 计划 panel 回到该计划的默认状态（`proposed` 即展开），MUST NOT 沿用上一份计划的折叠选择
  （否则新计划看起来"一条步骤都没有"）
