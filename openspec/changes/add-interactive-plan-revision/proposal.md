# add-interactive-plan-revision

## Why

计划卡的「改计划」目前**不是修改，而是推倒重来**：用户能点的只有一个按钮「重新规划」
（`packages/chat-client/src/components/PlanCard.vue:22`），宿主收到事件后发的是**一句硬编码文案**
（`HostAssistantDock.vue:209` / `WebAssistant.vue:209`：`send('这个计划不太合适，请重新规划')`）。
于是：

- **用户的意图无处表达**：没有输入口，用户没法说「第 3 步改成导出 CSV」「再加一步：结果同步给张三」，
  模型只能靠"不太合适"这四个字猜哪里不合适。
- **计划被全量重生成**：模型只能再调 `propose_plan` → `buildPlan()` 用 `crypto.randomUUID()` 造**新 planId**、
  步骤从 `step-1` 重新编号 → `session.recordPlan()` 把旧计划标 `superseded`
  （`packages/agent-server/src/session/session.service.ts:147`）→ **旧卡片作废、已完成的步骤进度全丢**。
- **稳定标识白设计了**：`PlanStep.id` 的注释写着「会话内稳定标识（进度交接按它对应）」
  （`packages/protocol/src/session.ts:55`），但 `propose_plan` 的入参 steps **只有 `{title,detail}`、没有 id** ——
  修订路径上根本没有"同一个步骤"这个概念，增量修改在协议层面不可能表达。
- **执行中的计划没有修改入口**：`PlanCard.vue:18` 的按钮只在 `!approved` 渲染，`foot` 文案让用户
  "直接说新的要求"，但那条消息不带任何"这是对当前计划的修改"意图，模型可能既不调工具、又全量重来。

`TODO.md:128` 里「计划的在线编辑」正是此前主动延后的一项 —— 本变更把它补上。

## What Changes

- **BREAKING** `protocol`：`chat.send` 新增 `revisePlanId`（"本轮是对某计划的修改意见"，与 `planId` 确认、
  `questionId` 回答对称）；`ToolName` / `TurnEndToolName` 新增 `revise_plan`；新增 `RevisePlanToolArgs`
  （每步可带 `id` 表示"原地改这一步"、`reopen` 表示"把已完成的步骤重新打开"）；
  `ChatPlanMessage` 新增 `status`（服务端权威状态）/ `revision` / `revisedAt` / `note`。
  本仓 `agent-server` 与 `chat-client` 配套发布，**不为旧客户端做兼容迂回**（同上次变更的取舍）。
- **agent-server：新增收尾工具 `revise_plan`（增量修订，而不是换计划）**
  - `turnEnd.ts` 新增纯函数：`normalizeReviseArgs`（未知 step id 直接抛错，避免"改了没生效"静默失败）、
    `mergePlanRevision`（按 id 就地改、保状态、新增取号、未出现的删除、按入参顺序重排、
    `planId` **不变**、`revision+1`、合并后再校验 `MAX_PLAN_STEPS`）、`describePlanChanges`（变更摘要文案）。
  - `session.service.ts` 新增 `revisePlan(session, planId, plan)`：**原地更新、不标 `superseded`**；
    planId 不匹配返回 `'stale'`；计划原本已批准时 → 回到 `proposed` 且**清空 `approvedAt`**
    （plan 门禁判据就是 `approvedAt`，不清就会"计划改了门禁还开着"）。
  - `agent.service.ts`：注册 `revisePlanTool`；`RunTurnOptions` 增加 `revisePlanId` 并记入
    `session.planTurn`；**修订轮里 `propose_plan` 被 `hooks.beforeTool` 硬拦**
    （reason 指引改用 `revise_plan`）—— "不许推倒重来"是服务端保证，不只靠 prompt；
    `resolveRunStatus()` 把 `revise_plan` 映射为 `waiting-plan`。
  - `manifest.service.ts`：prompt 注入「本轮是计划修改 + 用户修改意见」段，并新增规则：
    修改必须调用 `revise_plan`、回填完整步骤、未改动的必须带原 id、新增不给 id、删除不出现在入参、
    改到已完成步骤用 `reopen: true`。
  - `traceText.ts`：过程区新增一行文案（`revise_plan` → 「正在按你的意见更新计划」）。
  - `gateway/agent.gateway.ts`：`chat.send` 透传 `revisePlanId`，stale 时以可读文本提示重新提交。
- **chat-client：计划卡变成可交互的修订入口**
  - `PlanCard.vue`：次级按钮「重新规划」→ **「修改计划」**，点击在卡片内展开输入框（提交 / 取消），
    `emit('revise', text)`；徽标显示「已修订 · 第 N 版」+ 变更摘要 `note`；**已批准态也保留入口**
    （改完回到待确认）；另保留一个弱化的「重新生成计划」链接触发全量重来。
  - `lib/turnState.ts`：计划卡支持"修订草稿态"`beginPlanRevision / updatePlanDraft / cancelPlanRevision`；
    `applyPlan()` 支持**同 planId 的修订覆盖**并**跟随服务端 `status`**（不再无条件回到 `proposed`）。
  - `composables/useAgentChat.ts`：新增 `revisePlan(text, plan?)` → `sendWith(text, { revisePlanId })`。
  - `HostAssistantChat.vue` / `ChatPanel.vue` / `HostAssistantDock.vue` / `WebAssistant.vue` /
    `useWebAssistant.ts` / `src/index.ts`：新增并接线 `revise` 事件与 `revisePlan`，
    **删掉那句硬编码的"这个计划不太合适，请重新规划"**。

## Capabilities

### New Capabilities

（无新增能力：本次改的是既有 `planned-task-turns` 能力里的"改计划"这一条路径。）

### Modified Capabilities

- `planned-task-turns`: 把「重新规划 = 一句固定话 + 全量重生成」改成「交互式增量修订」——
  用户带修改意见（`chat.send.revisePlanId`）→ 模型调 `revise_plan` 回填完整步骤 →
  服务端按 `step id` 合并（保状态、保进度、`planId` 不变、`revision+1`）→ 计划卡原地更新；
  修订后需重新确认（已批准计划被改动即回到 `proposed`）。
  > 说明：`openspec/specs/` 目前尚无已归档基线（上次变更 `add-agent-modes-and-plan-turns`
  > 也未 archive），因此本 delta 里同时给出 `MODIFIED`（改「重新规划」那条既有 Requirement）
  > 与 `ADDED`（修订语义的新 Requirement）两份内容，均落在
  > `specs/planned-task-turns/spec.md`。

## Impact

- `packages/protocol`：`src/websocket.ts`（`ChatSendMessage.revisePlanId`、`ToolName` / `TurnEndToolName`、
  `RevisePlanToolArgs`、`ChatPlanMessage.status|revision|revisedAt|note`）、`src/session.ts`
  （`AgentPlan.revision|revisedAt`、`PlanTurn` 意图）。
- `packages/agent-server`：`src/agent/turnEnd.ts`（`normalizeReviseArgs` / `mergePlanRevision` /
  `describePlanChanges` / `projectTurnEnd` 分支）、`src/agent/agent.service.ts`（工具 + 修订轮门禁 +
  `RunTurnOptions`）、`src/agent/traceText.ts`、`src/session/session.service.ts`（`revisePlan` /
  `planTurn`）、`src/gateway/agent.gateway.ts`、`src/manifest/manifest.service.ts`（prompt 段 + 规则 15）。
- `packages/chat-client`：`src/components/PlanCard.vue`、`src/lib/turnState.ts`、
  `src/composables/useAgentChat.ts`、`src/composables/useWebAssistant.ts`、
  `src/components/{HostAssistantChat,ChatPanel,HostAssistantDock}.vue`、`src/WebAssistant.vue`、`src/index.ts`。
- 测试：`packages/agent-server/test/turnEnd.test.ts`（修订校验与合并）、新增 `test/session.revise.test.ts`、
  扩 `test/agent.run.test.ts` / `test/manifest.service.test.ts`、`packages/chat-client/test/turnState.test.mjs`、
  扩冒烟 `packages/agent-server/test/smoke-turns.mjs`（计划 → 修改 → 断言 planId/进度/revision）。
- 文档：`docs/agent-session.md`（协议表 + 状态机分支）、`PROJECT.md §6.10`、`TODO.md`（勾掉"计划的在线编辑"）。
- 发布：`.changeset`（`protocol` + `chat-client` minor，含 BREAKING 说明）；`agent-server` 为 private 包无版本。
