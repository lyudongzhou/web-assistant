# add-plan-manual-steps

## Why

计划只能由 agent 自己推进：`PlanStepStatus` 只有 `pending` / `done`
（`packages/protocol/src/session.ts`），进度靠模型在 `finish_turn({ done })` 里**自报**
（`turnEnd.ts` 的 `applyPlanProgress`）。但页面上有一部分功能 agent 本来就做不了：

- 动作是**写后端**的（保存 / 提交 / 删除 / 审批 / 导入导出），不在页面 `defineExpose` 的能力清单里；
- 需要**人本身**才能完成的（扫码、验证码、短信确认、线下动作）；
- `call_page_method` 直接返回权限不足 / 校验失败。

现在这套场景的落点是 prompt 规则 8 的一句「保存、新增、删除等写后端的动作不在可调用方法里，必须请用户在页面上确认提交」，
外加规则 13 的 `finish_turn`。于是：

1. **提示只在对话流里**：计划卡上只有 `pending`/`done` 两种标记，用户看不出"现在哪一步在等我"，
   滚一眼卡片也无法知道要做什么、做到什么算完成。
2. **没有"交回控制权"的推进口**：`chat.send` 只有 `planId`（确认）/ `revisePlanId`（改计划）/
   `questionId`（回答问题）。`ask_user` 的语义是"问你一个信息"（2~5 个选项的问题卡），
   拿它表达"请你去页面上把订单提交了"既不对味，也没有"我已完成"这个动作。
3. **进度是模型自报的 ⇒ 可能"自己假设用户做完了"**：`finish_turn` 的 `done` 由模型给，
   服务端全盘接受；模型完全可以把 `step-3` 直接填进 `done` 然后继续下一步。
4. **步骤没有"没做成 / 需重做"这个态**：后续步骤校验发现用户上一次操作没生效时，
   模型只能含糊说一句，用户看不到"哪一步、哪里不对、应该做成什么样"，也没有重做的入口。

## What Changes

- **protocol**：
  - `PlanStepStatus` 增 `'waiting-user'`（控制权已交回用户，等用户点「我已完成，下一步」）；
  - `PlanStep` 增 `owner?: 'agent' | 'user'` / `instructions?: string`（操作指引）/ `issue?: PlanStepIssue`（校验问题）；
  - 新增 `PlanStepIssue`（`reason` / `expected?` / `at`）与 `StepTurn`（本轮的人工步骤回执）；
  - `AgentSession` 增 `stepTurn?`；
  - `chat.send` 增 `stepDoneId?`（用户点「我已完成，下一步」= 被推进的步骤 id，与 `planId` 一起下发）；
  - `ToolName` / `TurnEndToolName` 增 `'handoff_step'`，新增 `HandoffStepToolArgs`
    （`{ stepId, instruction, issue?: { reason, expected? } }`）。
- **agent-server：新增收尾工具 `handoff_step`（把某一步交回用户）**
  - `turnEnd.ts` 新增纯函数：`normalizeHandoffArgs`（步骤必须存在且未完成、`instruction` 必填、计划必须已批准）、
    `applyHandoff`（目标步 → `waiting-user` + `owner: 'user'` + `instructions`（+ `issue`）；**其它 `waiting-user` 步骤收回 `pending`**
    —— 保证"至多一个步骤在等你"）、`applyUserStepDone`（用户点完后标 `done` 并清 `issue`）、`describeHandoff`（正常交接 / 校验失败两套文案）；
    `projectTurnEnd` 增 `handoff_step` 分支（推 `chat.plan` + 一条 `chat.text`，`suppressFallbackText: true`）；
    `resolveRunStatus` 把 `handoff_step` 映射为 `waiting-user`。
  - **`applyPlanProgress` 加硬约束**：`waiting-user` 的步骤**只能由用户推进** —— `finish_turn` 的 `done` 填了它也不生效、
    `doneAll: true` 也不会把计划置 `completed`（"不许自己假设用户做完了"是服务端保证，不只靠 prompt）。
  - `session.service.ts`：新增 `completeUserStep(session, planId, stepId)`（返回 `done` / `stale` / `mismatch` / `none`）
    与 `setStepTurn`（本轮回执意图，与 `planTurn` 对称、每轮重置）。
  - `gateway/agent.gateway.ts`：透传 `stepDoneId`；推进成功后**立刻回推一张权威卡片**
    （不推的话那一轮很可能一张卡片都不推 —— 模型直接继续下一步、或 `finish_turn` 只推文本 ——
    界面会一直停在"轮到你操作"，用户以为白点了）；过期 planId / 不是当前等待中的步骤时回可读文本。
  - `manifest.service.ts`：新增规则 16（**判据**：清单里有对应方法 → 自己做；写后端 / 需要人 / 调用被拒 → `handoff_step` 交接）、
    规则 17（用户回「已完成第 N 步」后**先校验再继续**，没做成就带 `issue` 让他重做，不要替他做也不要静默往下走）；
    `[当前计划]` 段落标注人工步骤与等待中的步骤；新增 `[用户已完成第 N 步]` 注入段。
  - `traceText.ts`：`handoff_step` 的过程区文案。
- **chat-client：计划卡上的人工步骤可见、可推进**
  - `lib/turnState.ts`：新增 `handoffStep`（取当前等待中的步骤）/ `beginStepCompletion` / `settleStepCompletion`
    与 `describeStepStatus`；`PlanCard` 增 `completingStepId?`。
  - `PlanCard.vue`：步骤行三态（`done` / **`waiting-user`（⚠ 徽标 + 操作指引 + `issue` 原因）** / `pending`）；
    折叠头 meta 在等待时显示「等待你在页面上操作 · 第 N 步」（折起来也看得见）；动作条主按钮换成
    **「我已完成，下一步」**（`issue` 非空时「我已重做，下一步」）→ `emit('step-done', stepId)`。
  - `ChatPanel.vue` / `HostAssistantChat.vue` / `HostAssistantDock.vue` / `WebAssistant.vue` /
    `useWebAssistant.ts` / `index.ts`：接线 `step-done` 事件与 `completeStep`（两条渲染面共用同一批组件，不许漂移）。
  - `composables/useAgentChat.ts`：`completeStep(plan?, stepId?)` → `sendWith('已完成第 N 步', { planId, stepDoneId })`；
    `lib/agentSocket.ts` 的 `ChatSendOptions` 增 `stepDoneId`。
- **取舍（明确不做）**：**不在 `propose_plan` / `revise_plan` 时预先声明"这步归谁"** ——
  某一步是否需要用户手做，取决于执行到那一步时页面**实际**能给什么能力（同一个"保存"按钮，有的页面 expose 了、
  有的没有），所以判定权在执行期、`owner` 只由 `handoff_step` 写入。计划卡上不出现"预计需要你操作"这类预告，
  避免"计划说 agent 做、结果要用户做"的错位观感。

## Capabilities

### New Capabilities

（无新增能力：`planned-task-turns` 已覆盖"计划式分轮推进"，本次是给这条路径补上**人工步骤**支路。）

### Modified Capabilities

- `planned-task-turns`: 分轮推进补上人工步骤 —— agent 做不了的一步用 `handoff_step` 交回用户
  （计划卡该步 `waiting-user` + 操作指引），用户手做完点「我已完成，下一步」（`chat.send.stepDoneId`）才推进；
  后续步骤校验发现没做成时用 `handoff_step({ issue })` 提示重做。
  > 说明：`openspec/specs/` 目前尚无已归档基线（前两个变更也未 archive），因此 delta 落在
  > `specs/planned-task-turns/spec.md`，同时给出 `MODIFIED`（分轮推进那条 Requirement 的补充）与 `ADDED`。

## Impact

- `packages/protocol`：`src/session.ts`（`PlanStepStatus` / `PlanStep` / `PlanStepIssue` / `StepTurn` / `AgentSession.stepTurn`）、
  `src/websocket.ts`（`chat.send.stepDoneId`、`ToolName` / `TurnEndToolName`、`HandoffStepToolArgs`、`ChatDoneMessage.endedBy` 注释）。
- `packages/agent-server`：`src/agent/turnEnd.ts`、`src/agent/agent.service.ts`（工具 + `RunTurnOptions.stepDoneId` + 回执落 session）、
  `src/agent/traceText.ts`、`src/session/session.service.ts`、`src/gateway/agent.gateway.ts`、`src/manifest/manifest.service.ts`。
- `packages/chat-client`：`src/lib/turnState.ts`、`src/lib/agentSocket.ts`、`src/composables/useAgentChat.ts`、
  `src/composables/useWebAssistant.ts`、`src/components/{PlanCard,ChatPanel,HostAssistantChat,HostAssistantDock}.vue`、
  `src/WebAssistant.vue`、`src/index.ts`。
- 测试：`packages/agent-server/test/turnEnd.test.ts`（交接校验 / 状态迁移 / 投影 / `finish_turn` 不越过 `waiting-user`）、
  新增 `test/session.handoff.test.ts`、扩 `test/manifest.service.test.ts`（规则 16/17 + 注入段）、
  `packages/chat-client/test/turnState.test.mjs`（人工步骤状态迁移）、扩 `test/render-panel.mjs`（卡片上的指引与按钮）、
  扩冒烟 `packages/agent-server/test/smoke-turns.mjs`（`SMOKE_EXPECT=handoff`）。
- 文档：`docs/agent-session.md` 新增 §4.8、`PROJECT.md`、`TODO.md`。
- 发布：`.changeset`（`protocol` + `chat-client` minor；`agent-server` 为 private 包无版本）。
