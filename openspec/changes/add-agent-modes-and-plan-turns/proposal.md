# add-agent-modes-and-plan-turns

## Why

复杂任务会被**硬中断**：`MAX_AGENT_STEPS`（`agent-server/src/agent/agent.service.ts:31`，默认 6）是 SDK 单轮 ReAct 的迭代上限，打满后 SDK **抛错**：

```js
// @cline/agents AgentRuntime.execute()
while (this.config.maxIterations === void 0 || this.state.iteration < this.config.maxIterations) { … }
throw Error(`Agent runtime exceeded maxIterations (${this.config.maxIterations})`)
```

抛出后被 catch → `status: 'failed'` → 服务端发 `chat.error`。于是「查一下三张数据源并做对比」这类任务在第 6 步断在半路，
用户看到的是一条红色错误，只能自己再打一句「继续」——**任务的连续性被"一轮 run"这个实现细节绑架了**。

第二个问题：用户描述不全时（"帮我看看那个用户的详情"——哪个用户？），agent 没有"提问"这个动作，
只能猜参数或退化成"展示列表让你自己选"，把本该一轮澄清的事拖成多轮试错。

`protocol/src/session.ts:12` 的 `AgentRunStatus` 里**早就声明了 `'waiting-user'` 却从未使用** —— 原设计预留的位置就在这里：
一轮 run 应该能停在「等用户决策」这个正常状态上，而不是被步数上限判为失败。

## What Changes

- **BREAKING** `protocol`：新增三个 server→client 消息 `chat.mode` / `chat.plan` / `chat.ask`；`chat.send` 增加 `mode` / `planId` / `questionId` 字段；`ToolName` 增加 `propose_plan` / `finish_turn` / `ask_user`；`AgentRunStatus` 增加 `'waiting-plan'` 并启用既有 `'waiting-user'`；`AgentSession` 增加 `mode` / `plan` / `pendingQuestion`。
  本仓 `agent-server` 与 `chat-client` 配套发布（monorepo），**不为旧客户端做降级迂回**（不复用 `chat.text` 传卡片的文本形态）。
- **agent-server：三个模式（act / plan / auto）**
  - 新增 `src/agent/mode.ts`（纯函数）：`auto` 下用启发式判定（多目标信号词 / 跨页 / 缺参 → plan；单页且参数齐全 → act；不确定 → 交给模型自判），判定结果落成 `session.mode = { requested, effective, decidedBy, reason }` 并每轮通过 `chat.mode` 让 UI 可见。
  - **plan 门禁（硬拦）**：`session.plan.approvedAt == null` 时，`hooks.beforeTool` 对 `render` / `call_page_method` 返回 `{ skip: true, reason }` —— 工具根本不执行，模型收到 `isError` 的 tool-result 并被告知解锁方式。
- **agent-server：三个收尾工具（`lifecycle.completesRun`）**
  - `propose_plan({ summary, steps[] })`：出计划，本轮 run 以 `completed` 收尾，进入等确认。
  - `ask_user({ question, options[2..5] })`：提问，本轮 run 以 `completed` 收尾，进入等回答。
  - `finish_turn({ summary, done[], remaining[], doneAll })`：进度交接，任何一轮都能优雅收尾。
  - 三者都**不走 `rpc.call`**：execute 只更新 session 并返回结构化载荷，由 `src/agent/turnEnd.ts`（纯函数）投影成 `chat.plan` / `chat.ask` 与进度文本。
- **agent-server：步数软着陆 + 失败降级**
  - `hooks.beforeModel`：`snapshot.iteration >= MAX_ITERATIONS - 1` 时往**当次请求**追加一条 SYSTEM 提醒（不写 transcript），让模型在最后一步优先 `finish_turn`。
  - 仍撞上限时，`agent.service.ts` 识别 `exceeded maxIterations` 并**降级为「已暂停」**（发正常 `chat.done` + 一条助手文本），不再发 `chat.error`。
  - `MAX_AGENT_STEPS` 默认 6 → 12。
- **回合边界统一**：计划确认、澄清提问、进度交接三件事都表现为「以收尾工具结束本轮 → session 进入 waiting 状态 → 用户操作经 `chat.send(mode|planId|questionId)` 起下一轮」，**一套状态机**，不需要阻塞式提问、不需要 `consumePendingUserMessage`。
- **chat-client**：新增 `PlanCard` / `AskCard` / `ModeSwitch` 三个组件与 `useAgentChat` 的 `mode` / `plan` / `pendingAsk` 状态；`HostAssistantChat` / `ChatPanel` / `HostAssistantDock` 接线（状态行显示生效模式与判定来源）。

## Capabilities

### New Capabilities

- `agent-modes`: act / plan / auto 三种模式的语义、`auto` 的三层判定（显式 > 启发式 > 模型自判）、判定结果的可见性（`chat.mode` + UI），以及 **plan 模式下未确认计划时的硬门禁**。
- `planned-task-turns`: `propose_plan` → 计划卡片 → 用户确认 → 分轮推进（每轮以 `finish_turn` 交接进度，计划与进度注入下一轮上下文）的完整回合契约。
- `agent-clarifying-questions`: `ask_user` 提问回合（2~5 个选项）、`session.pendingQuestion` 生命周期、用户以选项或自由文本回答后如何续跑。
- `agent-turn-budget`: 单轮步数的**软着陆**（`beforeModel` 倒数一步提醒）与**失败降级**（步数用尽 ≠ 错误），保证任何一轮都不会以 `chat.error` 收场。

### Modified Capabilities

（`openspec/specs/` 尚无已归档 spec，本变更全部为新增能力。）

## Impact

- `packages/protocol`：`src/websocket.ts`（`ToolName` / `ChatSendMessage` / `chat.mode|plan|ask` / 三个工具入参类型）、`src/session.ts`（`AgentMode` / `AgentRunStatus` / `AgentSession.mode|plan|pendingQuestion`）。
- `packages/agent-server`：新增 `src/agent/mode.ts`、`src/agent/turnEnd.ts`；改 `src/agent/agent.service.ts`（工具、hooks、模式、降级）、`src/agent/traceText.ts`（新工具文案）、`src/session/session.service.ts`（计划/提问生命周期）、`src/gateway/agent.gateway.ts`（`chat.send` 分派）、`src/manifest/manifest.service.ts`（`buildAgentContext` 注入模式/计划/提问段 + 新规则）、`.env.example` / `README.md`（env 表）。
- `packages/chat-client`：`src/lib/agentSocket.ts`、`src/composables/useAgentChat.ts`、`src/components/{PlanCard,AskCard,ModeSwitch}.vue`、`src/components/{HostAssistantChat,ChatPanel,HostAssistantDock}.vue`、`src/index.ts` / `src/types.ts`。
- 测试：新增 `packages/agent-server/test/mode.test.ts`、`test/turnEnd.test.ts`、`test/session.plan.test.ts`；扩 `test/traceText.test.ts`；`packages/chat-client/test/*`。
- 文档：`PROJECT.md`（新增「模式与回合边界」一节）、`docs/agent-session.md`（协议表 + UX）、`TODO.md`（勾 `waiting-user`、增 `waiting-plan`）、根 `README.md`。
- 发布：`.changeset` 记录 `protocol` / `chat-client`（含 breaking 说明）；`agent-server` 为 private 包无需版本。
