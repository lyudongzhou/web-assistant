---
'@webassistant/protocol': minor
'@webassistant/chat-client': minor
---

模式与回合边界：act / plan / auto + 计划卡 / 提问卡 / 进度交接（`add-agent-modes-and-plan-turns`）

修的是「复杂任务跑到一半被单轮步数上限**硬中断**」这一类问题 —— 根因是 SDK 在打满
`maxIterations` 时**抛错**（`Agent runtime exceeded maxIterations`），服务端把它 catch 成
`failed` → `chat.error`；一轮 run 被当成了任务的全部，用户只能自己再打一句"继续"。
顺带补上第二个缺口：信息不足时 agent 没有"提问"这个动作，只能猜参数或退化成"列表让你自己选"。

### protocol（**break**：新增 t / 字段，旧客户端会忽略新消息）

- **新增 server 消息**：`chat.mode`（本轮模式判定）/ `chat.plan`（计划卡）/ `chat.ask`（问题卡）。
- `chat.send` 新增可选 `mode`（`auto` / `act` / `plan`）/ `planId`（确认计划）/ `questionId`（回答提问）。
- `chat.done` 新增可选 `endedBy`（本轮怎么结束的：`propose_plan` / `ask_user` / `finish_turn`）。
- `ToolName` 新增 `propose_plan` / `ask_user` / `finish_turn`（服务端收尾工具，**不会**出现在 `tool.call` 里，
  只为过程区文案与类型完备）；新增 `TurnEndToolName`。
- `AgentRunStatus` 新增 `'waiting-plan'`，并把早已声明未用的 `'waiting-user'` 用起来
  （都表示"上一轮停在等用户决策"，run 已结束）。
- `AgentSession` 新增 `mode` / `modeDecision` / `plan` / `pendingQuestion`（都是 connection-scoped 状态）。
- 新增类型：`AgentMode` / `EffectiveMode` / `ModeDecidedBy` / `ModeDecision` / `AgentPlan` /
  `PlanStep` / `AgentPlanStatus` / `PendingQuestion` 与三个工具入参类型。

### chat-client

- **`chat.send` 支持附加指令**：`agentSocket.sendChat(text, { mode, planId, questionId })`；
  新增导出 `ChatSendOptions`。
- **新增 `lib/turnState.ts`**（纯逻辑，可单测）：模式条 / 计划卡 / 问题卡的状态迁移
  （`applyMode` / `applyPlan` / `applyAsk` / `approvePlanCard` / `answerAskCard` / `pendingQuestionId` /
  `describeMode` / `MODE_OPTIONS`）。
- **`useAgentChat`**：处理 `chat.mode` / `chat.plan` / `chat.ask`，新增 `mode` / `plan` / `ask` 状态与
  `sendWith` / `confirmPlan` / `sendWithMode`；`send()` 在有待回答问题时会自动带上 `questionId`
  （用户直接打字即回答）；`reset()` 一并清空卡片（会话 = 连接）。
- **新增三个组件**：`PlanCard`（步骤列表 + 「开始执行」/「重新规划」）、`AskCard`（问题 + 选项按钮）、
  `ModeSwitch`（自动 / 直接执行 / 先出计划 + 生效模式与判定来源），并从包入口导出。
- **`HostAssistantChat` / `ChatPanel`**：新增可选 props `plan` / `ask` / `mode` / `showModeSwitch` 与
  事件 `approve-plan` / `replan` / `answer` / `change-mode`（数据进、事件出，两条渲染面共用同一批组件）。
- **`WebAssistant` / `HostAssistantDock`**：接线卡片与模式切换（模式选择在**下一轮**随 `chat.send` 下发，
  不打断正在跑的一轮）。
- **`useWebAssistant`**：透出 `mode` / `plan` / `ask` / `sendWith` / `confirmPlan` / `sendWithMode`。

### agent-server（private，无版本号）

- 新增 `src/agent/mode.ts`（模式三层判定，纯函数）与 `src/agent/turnEnd.ts`（收尾工具入参校验 +
  产物 → 消息投影，纯函数）。
- 新增三个收尾工具（`lifecycle.completesRun`）+ `hooks.beforeModel`（倒数一步收尾提醒）+
  `hooks.beforeTool`（plan 硬门禁）；`MAX_AGENT_STEPS` 默认 6 → 12；`exceeded maxIterations`
  降级为「已暂停」；新增 `MODE_DEFAULT` / `PLAN_GATE` 两个 env。

测试：`agent-server/test/{mode,turnEnd,session.turns,agent.run}.test.ts`、
`chat-client/test/turnState.test.mjs`。
