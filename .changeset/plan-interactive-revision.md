---
'@webassistant/protocol': minor
'@webassistant/chat-client': minor
---

计划的交互式修订：改计划不再推倒重来（`add-interactive-plan-revision`）

修的是「点『重新规划』等于重做计划」这一类问题 —— 旧实现只有一个按钮、宿主发的是**一句固定文案**
（`send('这个计划不太合适，请重新规划')`）：用户说不出"改哪一步"，模型只能再 `propose_plan` →
新 `planId` + 步骤从 `step-1` 重新编号 + 旧计划标 `superseded` → **已完成步骤的进度全丢**。
现在把它做成"带输入、带意图、可增量"的一条路径，并且"不许推倒重来"由服务端保证。

### protocol（**break**：新增必填字段，旧客户端会忽略新消息 / 反序列化缺字段）

- **新增收尾工具 `revise_plan`**：`ToolName` / `TurnEndToolName` 增加 `'revise_plan'`；新增
  `RevisePlanToolArgs`（`note?` / `summary?` / `steps[]`，每步 `id?` / `title` / `detail?` / `reopen?`）
  并并入 `ToolArgs`。`steps` 是**修订后的完整步骤序列**：带 `id` = 原地改（保状态），不带 = 新增，
  未出现 = 删除。
- `chat.send` 新增 `revisePlanId`（"本轮是对某计划的修改意见"，与 `planId` 确认、`questionId` 回答对称）。
- `chat.plan` 新增 `status`（**必填**，`'proposed' | 'approved'`，服务端权威值）、`revision?`、`revisedAt?`、`note?`。
- `AgentPlan` 新增 `revision?` / `revisedAt?`；新增 `PlanTurn` 与 `AgentSession.planTurn?`。

### chat-client

- **`PlanCard`**：次级按钮「重新规划」→ **「修改计划」**（卡内展开输入框 + 「提交修改」/「取消」，
  `emit` 事件为 `open-revision` / `revision-input` / `cancel-revision` / `revise`）；展示
  「已修订 · 第 N 版」与变更摘要 `note`；**已批准态同样可改**（改完回到待确认）；
  弱化链接「重新生成计划」保留全量重来（`emit('replan')`）。
  **与过程区同构的 panel**：过程区与计划卡共用 `PanelSection`（壳：分隔线 / 折叠头 / 状态行 / 详情 / 动作条）
  与 `usePanelOpen`（唯一的收缩逻辑）；折叠头都是 `chev + title + meta`、chevron 在最左、整行可点、**等高**。
  **折叠粒度一致：收起 = 只剩折叠头一行** —— 计划 panel 收起时详情与动作条（「开始执行 / 修改计划」）
  一起收起，不留常驻按钮行；**默认折叠值跟随状态**（待确认展开、执行中收起，点「开始执行」后自动收成一行）。
  提交修改后**立即收起输入框**并显示「正在按你的意见更新计划…」（状态行，折叠时也可见）。
- **`lib/turnState.ts`**：`applyPlan()` 跟随服务端 `status`（不再无条件重置为 `proposed`）；
  新增修订草稿态纯函数 `beginPlanRevision` / `updatePlanDraft` / `cancelPlanRevision` /
  `submitPlanRevision`（提交即收起草稿）/ `settlePlanRevision`。
  （面板折叠态**不在**这里：它是纯视图状态，与过程区共用 `usePanelOpen`。）
- **`useAgentChat` / `useWebAssistant`**：新增 `revisePlan(text, plan?)`（→
  `sendWith(text, { revisePlanId })`）与 `beginPlanRevision` / `updatePlanDraft` / `cancelPlanRevision` / `replan`。
- **`agentSocket.sendChat`**：`ChatSendOptions` 增加 `revisePlanId`。
- **`HostAssistantChat` / `ChatPanel`**：新增事件 `revise` / `revision-open` / `revision-input` / `revision-cancel`
  （`replan` 语义收窄为"重新生成"）。**BREAKING**：接了 `replan` 的宿主请按需改接 `revise`。
- **新增 `PanelSection` / `usePanelOpen` 并导出**：过程区与计划卡共用的可折叠面板壳与收缩逻辑
  （宿主自写 panel 时可用同一套，避免第三个面板又长成另一种折叠样式）。
  壳负责"同构的那几行"：分隔线 / 底纹、折叠头（chevron 在最左 + **等高行高**）、常驻状态行、
  **详情限高滚动**（`--wa-panel-body-max`，缺省 200px）、`flex: 0 0 auto`（面板不被长内容压扁）；
  `usePanelOpen` 的默认值可传 **getter**（默认值本身是状态时用：值变则跟随，值没变不弹回用户的手动折叠）。
  **注意语义变化**：`#footer` 槽从"常驻"改为**随详情收起**（折叠 = 只剩折叠头一行，与过程区一致）；
  自定义 panel 若依赖常驻 footer，请把内容放进 `#head-actions`。`TraceTimeline` 的 `.trace-panel` 类
  （`flex: 0 0 auto` 的那条）已删除，宿主若命中过它请改用 `.panel`。
- **`TraceTimeline` 改用共用壳**：`思考中…` 移到常驻状态行（折叠时也可见），样式里只剩过程内容本身。
- **`WebAssistant` / `HostAssistantDock`**：接线上述事件，并**删掉硬编码的"这个计划不太合适，请重新规划"**。

### agent-server（private，无版本号）

- `src/agent/turnEnd.ts`：新增纯函数 `normalizeReviseArgs` / `mergePlanRevision` / `describePlanChanges` /
  `describePlanRevision` / `planCardStatus`；`projectTurnEnd` 增加 `revise_plan` 分支（同 planId + revision + 变更摘要）；
  `buildPlan()` 补 `revision: 1`。
- `src/session/session.service.ts`：新增 `revisePlan()`（原地更新、不标 `superseded`；已批准 → 回 `proposed` 并清 `approvedAt`）
  与 `setPlanTurn()`。
- `src/agent/agent.service.ts`：注册 `revisePlanTool`；`RunTurnOptions` 增加 `revisePlanId` 并写入 `session.planTurn`；
  修订轮用 `hooks.beforeTool` **硬拦 `propose_plan`**；`resolveRunStatus` 把 `revise_plan` 映射为 `waiting-plan`。
- `src/manifest/manifest.service.ts`：prompt 注入「本轮是计划修改 + 用户修改意见」段与规则 15；
  计划段在修订后标注版本。`traceText.ts` 增加 `revise_plan` 过程区文案。`gateway` 透传 `revisePlanId` 并处理过期卡片。

测试：`agent-server/test/turnEnd.test.ts`（修订校验与合并语义）、新增 `test/session.revise.test.ts`、
扩 `test/agent.run.test.ts` / `test/manifest.service.test.ts` / `test/traceText.test.ts`、
`chat-client/test/turnState.test.mjs`；冒烟新增 `SMOKE_EXPECT=revise` 档（真调模型，实测通过）。
