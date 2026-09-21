## 1. 协议层（protocol）

- [x] 1.1 `src/session.ts`：新增 `AgentMode`（`auto`/`act`/`plan`）、`EffectiveMode`、`ModeDecision`（`requested`/`effective`/`decidedBy`/`reason`）、`AgentPlan`（id/summary/steps/status/createdAt/approvedAt/completedAt）、`PendingQuestion`（id/question/options/askedAt/answeredAt/answer）
- [x] 1.2 `src/session.ts`：`AgentRunStatus` 增加 `'waiting-plan'`；`AgentSession` 增加 `mode?` / `plan?` / `pendingQuestion?`
- [x] 1.3 `src/websocket.ts`：`ToolName` 增加 `propose_plan` / `finish_turn` / `ask_user`
- [x] 1.4 `src/websocket.ts`：`ChatSendMessage` 增加 `mode?` / `planId?` / `questionId?`
- [x] 1.5 `src/websocket.ts`：新增 server 消息 `chat.mode` / `chat.plan` / `chat.ask` 与 `ChatModeMessage` / `ChatPlanMessage` / `ChatAskMessage`、`PlanStep`
- [x] 1.6 `src/websocket.ts`：新增工具入参类型 `ProposePlanToolArgs` / `FinishTurnToolArgs` / `AskUserToolArgs` 并并入 `ToolArgs`
- [x] 1.7 `src/index.ts` 导出新类型；`pnpm --filter @webassistant/protocol build` + `typecheck` 通过

## 2. agent-server：模式骨架与步数软着陆（批 1）

- [x] 2.1 新增 `src/agent/mode.ts`：纯函数 `resolveMode({ requested, text, session, manifest })` → `ModeDecision`（层 1 显式 / 层 2 启发式 / 层 3 plan 倾向）
- [x] 2.2 `src/agent/mode.ts`：导出 `PLAN_HINT` 与 `MODE_PATTERNS`（多步信号词表）便于 prompt 与单测复用
- [x] 2.3 新增 `src/agent/turnEnd.ts`：纯函数 `projectTurnEnd({ tool, args, session })` → `{ messages, suppressText }`，把收尾工具映射为 `chat.plan` / `chat.ask` / 进度文本
- [x] 2.4 `src/agent/traceText.ts`：`describeToolStep` 支持 `propose_plan` / `ask_user` / `finish_turn` 三个新工具文案
- [x] 2.5 `src/agent/agent.service.ts`：`MAX_ITERATIONS` 默认 6 → 12
- [x] 2.6 `src/agent/agent.service.ts`：新增 `hooks.beforeModel` —— `snapshot.iteration >= MAX_ITERATIONS - 1` 时向当次请求追加收尾提醒
- [x] 2.7 `src/agent/agent.service.ts`：新增 `finish_turn` 工具（`lifecycle.completesRun`），execute 更新 `session.plan` 进度并返回结构化载荷
- [x] 2.8 `src/agent/agent.service.ts`：识别 `exceeded maxIterations` 错误 → 降级为 `chat.done` + 暂停文本，不发 `chat.error`
- [x] 2.9 `src/agent/agent.service.ts`：`run()` 接受 `{ mode, planId, questionId }`；轮首发 `chat.mode`
- [x] 2.10 `src/session/session.service.ts`：新增 `setMode` / `recordPlan` / `approvePlan` / `recordQuestion` / `answerQuestion` / `updatePlanProgress`
- [x] 2.11 `src/gateway/agent.gateway.ts`：`handleChatSend` 透传 `mode` / `planId` / `questionId` 并做关联（批准计划、标记回答）
- [x] 2.12 新增 `test/mode.test.ts`：锁定三层判定规则（显式 / 多步信号 / 单页 / 不确定）
- [x] 2.13 新增 `test/turnEnd.test.ts`：锁定收尾工具 → 消息投影与 suppressText
- [x] 2.14 `pnpm --filter agent-server test` / `typecheck` 通过

## 3. agent-server：plan 硬门禁与计划注入（批 2）

- [x] 3.1 `src/agent/agent.service.ts`：新增 `propose_plan` 工具（`completesRun`），写 `session.plan` 并返回结构化载荷
- [x] 3.2 `src/agent/agent.service.ts`：新增 `hooks.beforeTool` —— plan 模式 + 未批准计划时 `skip` `render` / `call_page_method`，reason 写明解锁方式
- [x] 3.3 `src/agent/agent.service.ts`：`PLAN_GATE=off` 时门禁降级为 `appendContext` 提示（不放行拦截）
- [x] 3.4 `src/manifest/manifest.service.ts`：`buildAgentContext` 注入「当前模式与门禁状态」「当前计划与进度」段
- [x] 3.5 `src/manifest/manifest.service.ts`：规则新增 —— 复杂任务先计划、计划未确认不得操作页面、一轮最多推进若干步、步数将尽先收尾
- [x] 3.6 `src/agent/agent.service.ts`：收尾为 `propose_plan` / `ask_user` 时抑制兜底 outputText（避免重复文本）
- [x] 3.7 `src/session/session.service.ts`：重新规划时清除批准状态（旧 planId 失效）
- [x] 3.8 `.env.example` / `README.md`：`MAX_AGENT_STEPS` 默认改 12，新增 `MODE_DEFAULT` / `PLAN_GATE`
- [x] 3.9 `test/session.plan.test.ts`：计划生命周期（提议/批准/重规划/进度/完成）

## 4. agent-server：澄清提问（批 3）

- [x] 4.1 `src/agent/agent.service.ts`：新增 `ask_user` 工具（`completesRun`，选项 2~5 校验），写 `session.pendingQuestion`
- [x] 4.2 `src/gateway/agent.gateway.ts`：`chat.send` 带 `questionId` 时标记该问题已回答；不带 id 时若存在待回答问题也视为已回答
- [x] 4.3 `src/manifest/manifest.service.ts`：`buildAgentContext` 注入「上一个提问与用户的回答」段
- [x] 4.4 `src/manifest/manifest.service.ts`：规则新增 —— 参数缺失或含义不清时先 `ask_user`，不得猜测业务参数
- [x] 4.5 `test/session.question.test.ts`：待回答生命周期（提问/选项非法/回答/连接销毁）

## 5. chat-client：模式 / 计划 / 提问 UI

- [x] 5.1 `src/lib/agentSocket.ts`：`sendChat(text, { mode, planId, questionId })`
- [x] 5.2 `src/lib/turnState.ts`（新，纯函数）：`chat.mode` / `chat.plan` / `chat.ask` 消息 → 状态与「当前卡片是否过期」判定
- [x] 5.3 `src/composables/useAgentChat.ts`：新增 `mode` / `plan` / `pendingAsk` 状态与 `handleServerMessage` 分支
- [x] 5.4 `src/composables/useAgentChat.ts`：`send()` 在待回答问题存在时自动携带 `questionId`；`confirmPlan()` / `sendWithMode()` 入口
- [x] 5.5 新增 `src/components/PlanCard.vue`：计划步骤列表 + 「开始执行」/「重新规划」
- [x] 5.6 新增 `src/components/AskCard.vue`：问题 + 选项按钮（点选即发送）
- [x] 5.7 新增 `src/components/ModeSwitch.vue`：自动 / 直接执行 / 先出计划 三态切换 + 展示判定来源
- [x] 5.8 `src/components/HostAssistantChat.vue`：接线卡片区与 `ModeSwitch`（数据进、事件出，不直连 socket）
- [x] 5.9 `src/components/ChatPanel.vue`：容器面对齐同样的接线
- [x] 5.10 `src/components/HostAssistantDock.vue`：状态行显示生效模式
- [x] 5.11 `src/composables/useWebAssistant.ts`：透出 `mode` / `plan` / `pendingAsk` / `confirmPlan` / `sendWithMode`
- [x] 5.12 `src/index.ts` / `src/types.ts`：导出新组件与类型
- [x] 5.13 `test/turnState.test.mjs`：锁定卡片状态机（模式切换、计划批准、提问回答、过期计划）
- [x] 5.14 `pnpm --filter @webassistant/chat-client test` / `typecheck` 通过

## 6. 文档、changeset 与验收

- [x] 6.1 `docs/agent-session.md`：协议表补 `chat.mode` / `chat.plan` / `chat.ask`、三个工具与回合边界状态机
- [x] 6.2 `PROJECT.md`：新增「模式与回合边界」一节（含 auto 三层判定与硬门禁）
- [x] 6.3 `TODO.md`：勾掉 `waiting-user`，补 `waiting-plan` 与本次新增能力
- [x] 6.4 根 `README.md`：核心机制补一条（计划式回合 / 澄清提问）
- [x] 6.5 `.changeset`：`protocol` + `chat-client`（含 breaking 说明）
- [x] 6.6 全仓 `pnpm typecheck` + `pnpm test` 通过
- [x] 6.7 端到端验收（`test/smoke-turns.mjs`，真调模型）：① 计划模式复杂任务 → `chat.mode(plan)` → `chat.plan` → 确认(planId) → render → `finish_turn`，全程无 `chat.error`；② `MAX_AGENT_STEPS=1` 强制打满 → 只见「已暂停」（`SMOKE_EXPECT=pause`）；③ 指代不明（"那个用户"）→ 问题卡 4 选项 → 回答后续跑（`SMOKE_EXPECT=ask`）；④ 计划确认前无 render（门禁生效）
- [x] 6.8 修一处验收发现的行为问题：`act` 模式仍会弹计划卡（prompt 未按模式分工）→ `buildAgentContext` 在直接执行模式下明确「不要调用 propose_plan，直接做，用 finish_turn 交接」
- [x] 6.9 `packages/agent-server/README.md`：新增「冒烟 / 端到端验收」一节（三个 smoke 脚本的用法与可调 env）
