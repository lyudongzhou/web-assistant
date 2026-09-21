# 任务：计划中的人工步骤（人机交接）

## 1. 协议（`packages/protocol`）

- [x] 1.1 `src/session.ts`：`PlanStepStatus` 增 `'waiting-user'`（注释写清它是控制权交接、且只认 `chat.send.stepDoneId`）
- [x] 1.2 `src/session.ts`：新增 `PlanStepIssue`（`reason` / `expected?` / `at`）；`PlanStep` 增 `owner?: 'agent' | 'user'` / `instructions?` / `issue?`
- [x] 1.3 `src/session.ts`：新增 `StepTurn`（本轮的人工步骤回执：`stepId` / `title` / `text` / `at`）；`AgentSession` 增 `stepTurn?`；文件头部注释补人工步骤这条回合边界
- [x] 1.4 `src/websocket.ts`：`ToolName` / `TurnEndToolName` 增 `'handoff_step'`；新增 `HandoffStepToolArgs` 并入 `ToolArgs`
- [x] 1.5 `src/websocket.ts`：`ChatSendMessage` 增 `stepDoneId?`；`ChatDoneMessage.endedBy` 与 `ChatPlanMessage` 注释同步
- [x] 1.6 `pnpm --filter @webassistant/protocol typecheck && build` 通过

## 2. 服务端：交接 / 推进的服务端不变量

- [x] 2.1 `src/agent/turnEnd.ts`：`normalizeHandoffArgs(args, plan)` —— 计划必须存在且未 `superseded`、`stepId` 必须命中且未 `done`、`instruction` 必填（超长截断）、`issue.reason` 非空才算问题
- [x] 2.2 `src/agent/turnEnd.ts`：`applyHandoff(plan, normalized, now)` —— 目标步 `waiting-user` + `owner: 'user'` + `instructions`（+ `issue`，无则不残留旧 issue），其它等待中的步骤收回 `pending`
- [x] 2.3 `src/agent/turnEnd.ts`：`applyUserStepDone(plan, stepId, now)` —— 只接受 `waiting-user` 的步骤，标 `done` 并清 `issue`；否则返回 `undefined`
- [x] 2.4 `src/agent/turnEnd.ts`：`describeHandoff(plan, step)` —— 正常交接 / 校验失败两套用户文案（含步骤序号与标题）
- [x] 2.5 `src/agent/turnEnd.ts`：`projectTurnEnd` 增 `handoff_step` 分支 → 推 `chat.plan` + `chat.text`，`suppressFallbackText: true`、`endedBy: 'handoff_step'`
- [x] 2.6 `src/agent/turnEnd.ts`：`applyPlanProgress` 硬约束 —— `waiting-user` 的步骤不被 `done` / `doneAll` 标成 done，计划也不会因此变 `completed`
- [x] 2.7 `src/agent/turnEnd.ts`：`mergePlanRevision` 命中 `waiting-user` 的步骤时保留 `owner` / `instructions` / `issue`（`reopen: true` 才回 `pending` 并清 `issue`）
- [x] 2.8 `src/session/session.service.ts`：`completeUserStep(session, planId, stepId)` → `'done' | 'stale' | 'mismatch' | 'none'`（用 2.3 的纯函数改计划）
- [x] 2.9 `src/session/session.service.ts`：`setStepTurn(session, turn | undefined)`（每轮重置，与 `setPlanTurn` 对称）
- [x] 2.10 `src/gateway/agent.gateway.ts`：`chat.send` 透传 `stepDoneId`；stale / mismatch 时回可读文本；日志补 `stepDoneId`

## 3. 服务端：工具与 prompt

- [x] 3.1 `src/agent/agent.service.ts`：注册 `handoffStepTool`（`lifecycle.completesRun`，execute 里 `applyHandoff` + `updatePlan` + `projectTurnEnd`）
- [x] 3.2 `src/agent/agent.service.ts`：`resolveRunStatus` 把 `handoff_step` 映射为 `waiting-user`
- [x] 3.3 `src/agent/agent.service.ts`：`RunTurnOptions` 增 `stepDoneId`；run 里重置并写入 `session.stepTurn`
- [x] 3.4 `src/agent/traceText.ts`：`handoff_step` 的过程区文案（带步骤序号/标题）
- [x] 3.5 `src/manifest/manifest.service.ts`：规则 16（判据：清单里有方法自己做 / 写后端或需人则交接 / 调用被拒不要硬试）+ 规则 17（先校验再继续，没做成就带 `issue` 让它重做）
- [x] 3.6 `src/manifest/manifest.service.ts`：`[当前计划]` 段落标注 `waiting-user` 的步骤（"等待用户完成"）与 `instructions`
- [x] 3.7 `src/manifest/manifest.service.ts`：新增 `[用户已完成第 N 步]` 注入段（用户原话 + 先校验 + 失败带 issue 重做）

## 4. 客户端：状态机与计划卡

- [x] 4.1 `src/lib/turnState.ts`：`PlanCard` 增 `completingStepId?`；新增 `handoffStep` / `beginStepCompletion` / `settleStepCompletion` / `describeStepStatus`
- [x] 4.2 `src/lib/turnState.ts`：`applyPlan` 收到新卡片时收尾 `completingStepId`（服务端权威）
- [x] 4.3 `src/components/PlanCard.vue`：步骤行三态样式 + `waiting-user` 的指引与 `issue` 提示
- [x] 4.4 `src/components/PlanCard.vue`：折叠头 meta 在等待时显示「等待你在页面上操作 · 第 N 步」
- [x] 4.5 `src/components/PlanCard.vue`：动作条主按钮「我已完成，下一步」/「我已重做，下一步」→ `emit('step-done', stepId)`

## 5. 客户端：两条渲染面与 socket

- [x] 5.1 `src/lib/agentSocket.ts`：`ChatSendOptions` 增 `stepDoneId` 并透传
- [x] 5.2 `src/composables/useAgentChat.ts`：`completeStep(plan?, stepId?)` → `sendWith(..., { planId, stepDoneId })` + 本地 `beginStepCompletion`；`chat.done` / `chat.error` 收尾；`reset` 清空
- [x] 5.3 `src/components/ChatPanel.vue` / `HostAssistantChat.vue`：新增 `step-done` 事件并转发
- [x] 5.4 `src/components/HostAssistantDock.vue` / `src/WebAssistant.vue`：接线 `@step-done`
- [x] 5.5 `src/composables/useWebAssistant.ts` / `src/index.ts`：透出 `completeStep` 与新的 turnState 纯函数

## 6. 测试

- [x] 6.1 `packages/agent-server/test/turnEnd.test.ts`：`normalizeHandoffArgs`（未知步骤 / 已完成的步骤 / 空 instruction / 无计划都抛错）
- [x] 6.2 `packages/agent-server/test/turnEnd.test.ts`：`applyHandoff`（置 `waiting-user` + 指引 + issue、其它等待步收回 `pending`）、`applyUserStepDone`（只认等待中的步骤、清 issue）
- [x] 6.3 `packages/agent-server/test/turnEnd.test.ts`：`projectTurnEnd(handoff_step)` 的消息与文案；`applyPlanProgress` 不越过 `waiting-user`（含 `doneAll`）
- [x] 6.4 `packages/agent-server/test/session.handoff.test.ts`（新增）：`completeUserStep` 四种结果 + `setStepTurn` 生命周期
- [x] 6.5 `packages/agent-server/test/manifest.service.test.ts`：规则 16/17 与两个注入段
- [x] 6.6 `packages/chat-client/test/turnState.test.mjs`：人工步骤的状态迁移（`handoffStep` / `beginStepCompletion` / `settleStepCompletion` / `applyPlan` 收尾）
- [x] 6.7 `packages/chat-client/test/render-panel.mjs`：等待中的步骤渲染指引与「我已完成，下一步」；收起的折叠头给出线索
- [x] 6.8 `packages/agent-server/test/smoke-turns.mjs`：`SMOKE_EXPECT=handoff` 一档（交接 → 点完成 → 校验失败 → issue 重做）
      —— 脚本与断言已就绪（含"用新建数据源并保存逼出人工步骤"的任务、`waiting-user` 检测、模拟点按钮、
      断言 `endedBy=handoff_step` 与推进结果；`SMOKE_HANDOFF_MISSING=1` 让假页面数据里**没有**新建的那条，
      专门复现"校验不通过 → 需你重做"，并在 issue 卡片上再模拟一次「我已重做」）。
      **真调模型实测通过**（demo-app 的 manifest + 本地 server）：① 成功路径 `endedBy: propose_plan → handoff_step → finish_turn`，
      指引为「…点击抽屉底部的『保存数据源』按钮提交（保存是写后端操作，只能由你确认）…」，用户推进后模型**先复核页面再收尾**；
      ② 纠错路径（`SMOKE_HANDOFF_MISSING=1`）实测出现 `需重做：step-3 …｜原因：刚刷新数据源列表，只看到「用户库」（id 2），
      没有名为「订单库」的数据源` —— 该步被 issue 交回重做，模型再校验、再次交回，全程无 `chat.error`。
      > 这一跑还揪出一个真 bug 并已修复：用户点过「我已完成」后该步已是 `done`，而最初"`done` 的步骤不许交接"一刀切，
      > 把**带 `issue` 的纠错交接**也拒了 ⇒ R3 真机上根本走不到。现在 `done` + 带 `issue` 允许（退回 `waiting-user` 重做）。
- [x] 6.9 `pnpm -r typecheck` + `pnpm test` 全绿

## 7. 文档与发布

- [x] 7.1 `docs/agent-session.md`：新增 §4.8「人工步骤与人机交接」（时序、判据、两种"等你"的区分）+ 协议表补 `stepDoneId` / `handoff_step`
- [x] 7.2 `PROJECT.md` / `TODO.md`：同步（TODO 里勾掉"人工步骤"相关的后续项/补记）
- [x] 7.3 `.changeset`：`protocol` + `chat-client` minor（agent-server private 无版本）
