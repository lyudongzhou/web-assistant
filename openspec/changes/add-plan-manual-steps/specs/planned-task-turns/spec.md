## MODIFIED Requirements

### Requirement: 多轮推进

计划执行 MUST 支持跨多轮：每一轮推进计划的若干步骤并以 `finish_turn` 收尾交接进度；系统 MUST 把「当前计划与已完成/剩余步骤」注入下一轮的模型上下文。
计划执行 MUST 支持**人工步骤**：agent 做不了的一步（写后端的动作 / 页面能力清单里没有对应方法 / 需要人本身才能完成 / 调用被拒）MUST 用收尾工具 `handoff_step` 把控制权交回用户，而不是自行假设已完成（见「人工步骤的交接」）。

#### Scenario: 一轮推进若干步骤后交接

- **WHEN** 计划已确认，模型在同一轮内完成了 2 个步骤
- **THEN** 模型调用 `finish_turn`（`done` 填这 2 步的 id），本轮 `chat.done.endedBy === 'finish_turn'`，计划的步骤状态被更新，下一轮上下文包含「当前计划与进度」

## ADDED Requirements

### Requirement: 人工步骤的交接

agent MUST 在执行计划时判断**这一步自己能不能做**，判据 MUST 是页面的事实能力（`manifest` 能力清单 / 运行时上报的 `page.exposed` / `call_page_method` 的返回结果），而不是推测：

- 动作能在当前页可用方法清单里找到 → agent 自己执行（`call_page_method`），MUST NOT 交接；
- 动作是写后端的（保存 / 提交 / 删除 / 审批）或清单里没有对应方法 → MUST `handoff_step`；
- 需要人本身才能完成的（扫码 / 验证码 / 短信确认 / 线下动作）→ MUST `handoff_step`；
- `call_page_method` 返回权限不足 / 校验失败 → MUST NOT 反复重试，改为 `handoff_step`。

`handoff_step({ stepId, instruction })` MUST 让该步骤进入 `waiting-user` 并记录 `owner: 'user'` 与面向用户的
**操作指引** `instructions`（在哪个页面、点什么、做到什么算完成）；`instruction` 缺失 MUST 被拒绝（工具错误）。
交接 MUST 是收尾动作：本轮 run MUST 以 `waiting-user` 正常结束（`endedBy === 'handoff_step'`），
并下发更新后的计划卡（同 `planId`）与一条可读的提示文本（含该步指引与"完成后点「我已完成，下一步」"）。
系统 MUST 保证**至多一个步骤处于 `waiting-user`**：交接新步骤时，其它仍在等待中的步骤 MUST 被收回 `pending`。

#### Scenario: 写后端的动作被交接给用户

- **WHEN** 计划执行到「保存订单」这步，该动作不在页面可用方法清单里
- **THEN** 模型调用 `handoff_step({ stepId: 'step-3', instruction: '在订单页填好数量后点「保存」' })`，本轮 `endedBy === 'handoff_step'`、
  计划的 `step-3.status === 'waiting-user'`（`owner: 'user'`、`instructions` 非空），客户端收到计划卡与提示文本

#### Scenario: agent 自己能做的一步不交接

- **WHEN** 某步的目标动作在「当前页可用方法」清单里（如 `nextPage()`）
- **THEN** agent 直接 `call_page_method` 完成该步，本轮 MUST NOT 因它交接给用户（计划卡上也不出现 `waiting-user`）

#### Scenario: 交接前的页面就位

- **WHEN** 需要用户操作的目标页不是当前页
- **THEN** agent MUST 先 `render` 到该页再交接，`instruction` MUST 指向用户此刻能操作的页面

#### Scenario: 至多一个步骤在等待

- **WHEN** `step-3` 处于 `waiting-user` 时，模型又对 `step-5` 调用 `handoff_step`
- **THEN** `step-5` 变为 `waiting-user`，`step-3` 回到 `pending`（同一时刻只有一个步骤在等用户）

#### Scenario: 引用不存在的步骤被拒绝

- **WHEN** `handoff_step` 的 `stepId` 不在当前计划里，或该步骤已经 `done` **且未带 `issue`**，或当前没有已确认的计划
- **THEN** 调用失败（`isError` 工具结果并说明原因），会话状态 MUST NOT 被改动

#### Scenario: 校验不通过把已完成的步骤退回重做

- **WHEN** 用户点过「我已完成」后该步已是 `done`，模型校验发现它其实没做成，于是调用 `handoff_step({ stepId, instruction, issue: { reason, expected? } })`
- **THEN** 该步 MUST 回到 `waiting-user`（`owner: 'user'`）并携带 `issue`，本轮下发带该 `issue` 的计划卡与提示文本
- **AND** 带 `issue` 的交接 MUST 被允许（不带 `issue` 去交接一个 `done` 的步骤 MUST 被拒绝）—— 这是"用户操作有误"能被指回那一步的唯一通道

### Requirement: 人工步骤由用户手动推进

`waiting-user` 的步骤 MUST **只能**由用户在计划卡上点「我已完成，下一步」推进 ——
客户端 MUST 发送 `chat.send({ text, planId, stepDoneId })`（`planId` 为当前计划，用于过期判断）。
服务端 MUST 把该步骤置为 `done` 并清空其 `issue`，然后起下一轮，把"用户完成了这一步"注入模型上下文。
不匹配的 `planId`（过期卡片）或不是当前等待中的步骤 id MUST NOT 改动计划，MUST 以可读文本提示用户。
`finish_turn` 的 `done` / `doneAll` MUST NOT 把 `waiting-user` 的步骤标成 `done`，
计划也 MUST NOT 因此在仍有 `waiting-user` 步骤时变成 `completed`。

#### Scenario: 用户点「我已完成，下一步」

- **WHEN** 计划卡上显示 `step-3` 为「需要你操作」，用户在页面上做完后点该按钮
- **THEN** 客户端发送 `chat.send({ text, planId, stepDoneId: 'step-3' })`，服务端把 `step-3` 置 `done`（并清 `issue`），
  本轮上下文含「用户已完成第 3 步」，模型据此校验并继续下一步

#### Scenario: 模型不能替用户勾掉人工步骤

- **WHEN** 存在 `waiting-user` 的步骤时，模型调用 `finish_turn({ done: ['step-3'], doneAll: true })`
- **THEN** `step-3` 仍为 `waiting-user`，计划 MUST NOT 变为 `completed`

#### Scenario: 过期或错位的推进被拒

- **WHEN** 客户端用过期 `planId` 提交，或 `stepDoneId` 指向的步骤当前不是 `waiting-user`
- **THEN** 计划不被改动，用户收到一条可读提示（刷新后重新在最新计划卡上操作）

### Requirement: 校验发现用户操作有误时给出提示

用户完成人工步骤后的后续轮次 MUST 允许模型**先校验**（读页面数据 / 调用页面方法 / 重新打开页面查看事实）再继续。
校验发现该步骤没做成 / 做错时，模型 MUST 用 `handoff_step({ stepId, issue: { reason, expected? } })` 把问题指回那一步：
该步骤 MUST 回到 `waiting-user` 并携带 `issue`，本轮 MUST 下发更新后的计划卡与提示文本（说明哪里不对、期望做成什么样），
MUST NOT 静默继续后续步骤、MUST NOT 由 agent 代替用户完成写后端的动作。
用户修正后再次点「我已重做，下一步」推进，推进时 MUST 清空 `issue`。

#### Scenario: 用户没做成 → 指回那一步

- **WHEN** 用户点了「我已完成」，但模型读页面事实发现订单并未保存
- **THEN** 模型调用 `handoff_step({ stepId: 'step-3', issue: { reason: '订单仍是草稿', expected: '状态为「已提交」' } })`，
  计划的 `step-3.status === 'waiting-user'` 且 `issue.reason` 非空，客户端计划卡在该步上显示失败提示

#### Scenario: 修正后重做成功

- **WHEN** 用户在页面上改好并再次点「我已重做，下一步」
- **THEN** 服务端把该步骤置 `done` 且 `issue` 被清空，模型继续后续步骤

### Requirement: 计划卡上的人工步骤可见可推进

计划卡 MUST 让用户一眼看出"现在轮到你在页面上操作哪一步"：
步骤行 MUST 区分 `waiting-user`（带醒目标记），MUST 显示该步的**操作指引** `instructions`，
`issue` 非空时 MUST 额外显示原因（`reason`）与期望（`expected`，若有）。
计划面板的折叠头 MUST 在存在等待中的步骤时给出可见线索（如「等待你在页面上操作 · 第 N 步」），
使面板**收起成一行时**用户仍知道该自己动手了；动作条 MUST 提供主按钮
「我已完成，下一步」（`issue` 非空时文案为「我已重做，下一步」），点击 MUST 产生一次带 `stepDoneId` 的发送。
点击后计划卡 MUST 进入"已完成该步、等待校验"的反馈态并在本轮结束（`chat.done` / `chat.error`）时收尾，
MUST NOT 由客户端在本地把该步骤标成 `done`（状态由服务端 `chat.plan` 权威下发）。

#### Scenario: 等待中的步骤带指引

- **WHEN** 收到 `chat.plan` 且某步骤为 `waiting-user`（`instructions` 非空）
- **THEN** 卡片在该步骤上显示需你操作的标记与指引文本，并显示主按钮「我已完成，下一步」

#### Scenario: 折起来也知道该自己动手

- **WHEN** 计划面板处于收起状态且存在 `waiting-user` 的步骤
- **THEN** 折叠头仍显示「等待你在页面上操作」这类线索（不必展开就能发现）

#### Scenario: 校验失败的提示在卡上可读

- **WHEN** 收到带 `issue` 的 `waiting-user` 步骤
- **THEN** 卡片显示「哪里不对」（`reason`）与「应该做成什么样」（`expected`），主按钮变为「我已重做，下一步」

#### Scenario: 点击后不本地推进

- **WHEN** 用户点「我已完成，下一步」
- **THEN** 客户端发出 `chat.send({ planId, stepDoneId })` 并显示"已完成该步、正在校验"的反馈，
  步骤的 `done` 只在服务端下发新的 `chat.plan` 后出现
