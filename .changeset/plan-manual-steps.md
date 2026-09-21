---
'@webassistant/protocol': minor
'@webassistant/chat-client': minor
---

计划中的人工步骤（人机交接）：`handoff_step` 把 agent 做不了的一步交回用户，用户点「我已完成，下一步」才推进

**改的问题**：页面上有一部分功能 agent 本来就做不了 —— 写后端的动作（保存 / 提交 / 删除 / 审批）、
不在页面能力清单里的操作、需要**人本身**才能完成的（扫码 / 验证码 / 短信确认），以及 `call_page_method`
被拒（权限不足 / 校验失败）。以前这类步骤只有 prompt 里的一句"必须请用户在页面上确认提交"，于是：

- 计划卡上**看不出"现在轮到你"**（步骤只有 `pending` / `done`，提示只飘在对话流里，滚掉了就没了）；
- **没有交回控制权的推进口**（`ask_user` 的语义是"问你一个信息"，不是"请你去页面上做件事"）；
- 进度是模型自报的 ⇒ 它可以把人工步骤直接填进 `finish_turn.done` 然后接着往下走；
- 用户没做对时**没有提示位置**：步骤上没有"没做成 / 需重做"这个态，只能含糊说一句。

### protocol（minor）

- `PlanStepStatus` 增 `'waiting-user'`（控制权已交回用户，等用户点「我已完成，下一步」）。
- `PlanStep` 增 `owner?: 'agent' | 'user'` / `instructions?`（操作指引）/ `issue?: PlanStepIssue`（校验问题）。
- 新增 `PlanStepIssue`（`reason` / `expected?` / `at`）与 `StepTurn`（本轮的人工步骤回执）；`AgentSession` 增 `stepTurn`。
- `chat.send` 增 `stepDoneId?`（用户点「我已完成，下一步」= 被推进的步骤 id，与 `planId` 一起下发）。
- `ToolName` / `TurnEndToolName` 增 `'handoff_step'`；新增 `HandoffStepToolArgs`
  （`{ stepId, instruction, issue?: { reason, expected? } }`）。

### chat-client（minor）

- `PlanCard` 步骤行三态：`done` / **`waiting-user`（⏳「需要你操作」+ 操作指引；`issue` 非空时「需你重做」+ 原因/期望）** / `pending`；
  **有步骤在等你时面板强制展开**（提示与按钮不能被折起来藏住），折叠头另给「等你操作」徽标、状态行给
  「等待你在页面上操作 · 第 N 步」线索；动作条主按钮换成「我已完成，下一步」（`issue` 时「我已重做，下一步」）。
- `lib/turnState.ts` 增 `handoffStep` / `beginStepCompletion` / `settleStepCompletion` / `describeStepStatus`
  与 `PlanCard.completingStepId`（本地只有"刚点完、等校验"的反馈态，步骤状态一律跟随服务端 `chat.plan`）。
- `useAgentChat.completeStep(plan, stepId)` → `chat.send({ planId, stepDoneId })`；新增 `handoff` computed
  （当前等你操作的那一步）供自写 UI 复用；`agentSocket` 的 `ChatSendOptions` 增 `stepDoneId`。
- 两条渲染面（`ChatPanel` / `HostAssistantChat`）与容器（`HostAssistantDock` / `WebAssistant`）接线
  `step-done` 事件；`index.ts` 转出新的纯函数与类型。

`agent-server` 为 private 包（无版本）：新增收尾工具 `handoff_step`（本轮以 `waiting-user` 收尾，
推 `chat.plan` + 一条指引文本）、`normalizeHandoffArgs` / `applyHandoff` / `applyUserStepDone` / `describeHandoff`、
`SessionService.completeUserStep` / `setStepTurn`、gateway 透传 `stepDoneId`（并立刻回推权威卡片）、
prompt 规则 16/17（判据：清单里有对应方法自己做 / 写后端或需人则交接 / 调用被拒不要硬试；用户说做完后**先校验**）
与 `[用户已完成某个步骤]` 注入段。**服务端保证**：`waiting-user` 的步骤不接受 `finish_turn.done` / `doneAll`
勾选，计划也不会因此变成 `completed` —— "不许自己假设用户做完了"不只靠 prompt。

判定权在 agent（执行到那一步时按页面实际能力判断），因此**不在 `propose_plan` 时预先声明谁做哪一步**。
