## 1. 协议层（protocol）

- [x] 1.1 `src/websocket.ts`：`ChatSendMessage` 增加 `revisePlanId?: string`（本轮是"对某计划的修改意见"，与 `planId` 确认 / `questionId` 回答对称）
- [x] 1.2 `src/websocket.ts`：`ToolName` 与 `TurnEndToolName` 增加 `'revise_plan'`
- [x] 1.3 `src/websocket.ts`：新增 `RevisePlanToolArgs`（`note?` / `summary?` / `steps[]`，每步 `id?` / `title` / `detail?` / `reopen?`）并并入 `ToolArgs`
- [x] 1.4 `src/websocket.ts`：`ChatPlanMessage` 增加 `status`（`'proposed' | 'approved'`，服务端权威状态）、`revision?`、`revisedAt?`、`note?`
- [x] 1.5 `src/session.ts`：`AgentPlan` 增加 `revision?` / `revisedAt?`；新增 `PlanTurn`（`kind: 'revise'` / `planId` / `text` / `at`）与 `AgentSession.planTurn?`
- [x] 1.6 `src/index.ts` 导出新类型；`pnpm --filter @webassistant/protocol build` + `typecheck` 通过

## 2. agent-server：修订的纯函数层（turnEnd.ts）

- [x] 2.1 `src/agent/turnEnd.ts`：`buildPlan()` 补 `revision: 1`
- [x] 2.2 `src/agent/turnEnd.ts`：新增 `normalizeReviseArgs(args, current)` —— `steps` 非空、`summary` 缺省沿用当前、**引用了当前计划不存在的 step id 时抛错**（模型收到 isError 自行修正）
- [x] 2.3 `src/agent/turnEnd.ts`：新增 `mergePlanRevision(plan, normalized, now)` → `{ plan, changes }`：命中 id 就地改（默认保状态，`reopen:true` 回 `pending`）、无 id 新增（取"最大序号 + 1"）、旧计划未出现的删除、按入参顺序重排、`planId` 不变、`revision + 1`、`revisedAt` 更新
- [x] 2.4 `src/agent/turnEnd.ts`：`mergePlanRevision` 对**合并后**结果校验 `MAX_PLAN_STEPS`（超限抛错且不改动计划）
- [x] 2.5 `src/agent/turnEnd.ts`：新增 `describePlanChanges(changes)` —— 生成"已更新计划：修改 1 步（第 3 步：导出 CSV）、新增 1 步"文案，并显式点出"移除 M 个已完成步骤"
- [x] 2.6 `src/agent/turnEnd.ts`：`projectTurnEnd` 支持 `tool: 'revise_plan'` → 推 `chat.plan`（同 planId + revision + status + note）+ 一条 `chat.text`（变更摘要），`suppressFallbackText: true`、`endedBy: 'revise_plan'`
- [x] 2.7 `src/agent/turnEnd.ts`：`projectTurnEnd` 的 `propose_plan` 分支补 `status: 'proposed'` / `revision: 1`
- [x] 2.8 新增/扩 `test/turnEnd.test.ts`：`normalizeReviseArgs`（未知 id 抛错、空 steps 抛错、summary 沿用）与 `mergePlanRevision`（保 id 保 done / reopen / 新增取号 / 删除 / 重排 / 合并后超限 / revision+1）

## 3. agent-server：会话、工具与修订轮门禁

- [x] 3.1 `src/session/session.service.ts`：新增 `revisePlan(session, planId, plan)` —— planId 不匹配返回 `'stale'`；匹配则**原地更新（不标 superseded）**；原 `status === 'approved'` 时置 `proposed` 且清空 `approvedAt`
- [x] 3.2 `src/session/session.service.ts`：新增 `setPlanTurn(session, turn | undefined)` / `clearPlanTurn(session)`（修订意图，连接作用域）
- [x] 3.3 `src/agent/agent.service.ts`：注册 `revisePlanTool`（`lifecycle.completesRun`，description 明确"改动当前计划必须用它、回填完整步骤、未改动的带原 id、新增不给 id、删除不出现在入参、改到已完成步骤用 reopen"）
- [x] 3.4 `src/agent/agent.service.ts`：`RunTurnOptions` 增加 `revisePlanId`；`run()` 里写入 `session.planTurn`（每轮先清空），stale 时推可读文本提示"计划已更新，请在最新计划卡上重新提交修改"
- [x] 3.5 `src/agent/agent.service.ts`：`hooks.beforeTool` 在修订轮里对 `propose_plan` 返回 `{ skip: true, reason }`（指引改用 `revise_plan`）
- [x] 3.6 `src/agent/agent.service.ts`：`resolveRunStatus()` 把 `endedBy === 'revise_plan'` 映射为 `'waiting-plan'`
- [x] 3.7 `src/agent/agent.service.ts`：`revisePlanTool.execute` 走 `normalizeReviseArgs` → `mergePlanRevision` → `sessions.revisePlan` → `entry.turnEnd = projectTurnEnd({ tool: 'revise_plan', ... })`，并记一条 `revise_plan` 日志（planId / revision / 新增·修改·删除数）
- [x] 3.8 `src/gateway/agent.gateway.ts`：`chat.send` 日志与 `RunTurnOptions` 透传 `revisePlanId`；`resolveTurnEndInput()` 处理 stale（不误改当前计划）

## 4. agent-server：prompt 与过程区文案

- [x] 4.1 `src/manifest/manifest.service.ts`：`buildAgentContext` 新增「本轮是计划修改」段（用户的修改意见 + 当前 planId + 完整步骤 id 列表），非修订轮不出现
- [x] 4.2 `src/manifest/manifest.service.ts`：新增规则 15 —— 修改计划必须调用 `revise_plan`、回填完整步骤、未改动的保留原 id、新增不给 id、删除不出现在入参、改到已完成步骤用 `reopen: true`、**不得因一句修改意见就换新计划**
- [x] 4.3 `src/agent/traceText.ts`：`describeToolStep` 支持 `revise_plan`（「正在按你的意见更新计划」，target `plan`）
- [x] 4.4 扩 `test/manifest.service.test.ts`（修订轮 prompt 含「本轮是计划修改」与规则 15；非修订轮不含）与 `test/traceText.test.ts`（`revise_plan` 文案）
- [x] 4.5 新增 `test/session.revise.test.ts`：原地更新不 superseded、stale、`approved → proposed` 且清空 `approvedAt`

## 5. chat-client：状态机与 composable

- [x] 5.1 `src/lib/turnState.ts`：`applyPlan()` 跟随服务端 `status`（有 `status` 用消息里的，缺省才回落 `proposed`），支持同 planId 的修订覆盖
- [x] 5.2 `src/lib/turnState.ts`：新增修订草稿态纯函数 `beginPlanRevision` / `updatePlanDraft` / `cancelPlanRevision`，`PlanCard` 类型补 `draft?` / `revising?`
- [x] 5.3 `src/composables/useAgentChat.ts`：新增 `revisePlan(text, plan?)` → `sendWith(text, { revisePlanId })`，并在发送时把卡片切到修订态（`revising`）
- [x] 5.4 `src/lib/agentSocket.ts`：`ChatSendOptions` 增加 `revisePlanId` 并随 `sendChat` 透传
- [x] 5.5 `src/composables/useWebAssistant.ts`：透出 `revisePlan`
- [x] 5.6 `src/index.ts`：导出新增纯函数与类型（`beginPlanRevision` / `updatePlanDraft` / `cancelPlanRevision` 等）

## 6. chat-client：计划卡与两条渲染面接线

- [x] 6.1 `src/components/PlanCard.vue`：「重新规划」→「修改计划」（卡内展开输入框 + 提交/取消），`emit('revise', text)`；已批准态同样提供入口
- [x] 6.2 `src/components/PlanCard.vue`：展示 `note` / 「已修订 · 第 N 版」徽标；已批准态的 foot 文案指向「修改计划」；补一个弱化的「重新生成计划」链接（保留 `emit('replan')`）
- [x] 6.3 `src/components/HostAssistantChat.vue` / `src/components/ChatPanel.vue`：新增事件 `revise: (text: string)` 并接到 `PlanCard` 的 `@revise`
- [x] 6.4 `src/components/HostAssistantDock.vue` / `src/WebAssistant.vue`：新增 `onRevisePlan(text) → revisePlan(text)`，**删除硬编码的"这个计划不太合适，请重新规划"**（`replan` 保留给「重新生成计划」）
- [x] 6.5 扩 `test/turnState.test.mjs`：修订草稿态迁移、同 planId 覆盖、`approved → proposed` 回落、`status` 缺省时的兼容行为

## 7. 验收与全仓校验

- [x] 7.1 扩 `test/agent.run.test.ts`：`resolveRunStatus(revise_plan) === 'waiting-plan'`
- [x] 7.2 扩 `test/smoke-turns.mjs`：新增「计划 → 带 `revisePlanId` 的修改意见 → 断言 planId 不变、`step-1` 仍 `done`、`revision === 2`、无 `chat.error`」
- [x] 7.3 `pnpm typecheck` 全仓通过
- [x] 7.4 `pnpm test` 全仓通过（含 agent-server / chat-client 单测）

## 8. 文档与发布

- [x] 8.1 `docs/agent-session.md`：协议表补 `chat.send.revisePlanId` / `chat.plan.status|revision|note`、`revise_plan` 工具与修订轮门禁；§4.6 状态机图补一条修订分支
- [x] 8.2 `PROJECT.md §6.10`：补「计划的交互式修订」一段（含"修订 ≠ 重生成"与"改后重新确认"两条关键取舍）
- [x] 8.3 `TODO.md`：勾掉「计划的在线编辑」
- [x] 8.4 `.changeset/plan-interactive-revision.md`：`@webassistant/protocol` + `@webassistant/chat-client` minor（含 BREAKING 说明）

## 9. 修订后的界面收尾（验收发现的体验缺陷）

现象：提交修改意见后卡片仍停在「提交修改」输入视图（修订结果回来也不收起），用户看不到「开始执行」。
根因：`draft` 被当成"跨结果延续"的状态，而组件里 `editing` 只看 `draft` 是否存在。

- [x] 9.1 `src/lib/turnState.ts`：`submitPlanRevision` 提交即**收起输入框**（清 `draft`）+ 标"修改中"
- [x] 9.2 `src/lib/turnState.ts`：`applyPlan` 对同 planId 的再次下发也清 `draft`（服务端推来新卡片一律收起输入框）
- [x] 9.3 `test/turnState.test.mjs`：改掉原先锁"提交后草稿仍在 / 同计划延续"的两处断言，改为"提交即收起 + 结果回来后停在可操作态"，并新增"`applyPlan` 未走 submit 也收起"用例
- [x] 9.4 spec：`计划卡提供修改入口与修订可见性` 增加「提交后收起输入并回到可操作态」Scenario（防回归）

## 10. 过程与计划 = 两个同构 panel（验收反馈「计划面板不像过程区那样能折」）

- [x] 10.1 新增 `src/components/PanelSection.vue`：可折叠面板壳（`panel-head` / chevron 在最左 + `#head` 槽 / `#head-actions` / `#status` 常驻状态行 / body 随折叠 / `#footer` 常驻）；`title` 与 `meta` 的字号层级用 `:slotted()` 定义，保证两个 panel 的折叠头排版同源
- [x] 10.2 新增 `src/composables/usePanelOpen.ts`：**唯一的收缩逻辑**（`open` + `toggle` + 可选 `resetKey`：内容身份变化即回到 `defaultOpen`），纯响应式、可在 node 里单测
- [x] 10.3 `src/components/TraceTimeline.vue`：改用 `PanelSection` + `usePanelOpen`（`思考中…` 移到 `#status`，折叠时也可见）；样式里只剩"过程内容"自己那部分
- [x] 10.4 `src/components/PlanCard.vue`：改为 `PanelSection class="plan-card"`；`#head` = 徽标 + 第 N 版 + 目标摘要 + `已完成 1/3`；`#status` = 修订中提示；body = 步骤 / 变更摘要 / 说明；`#footer` = 「开始执行 / 修改计划」（**常驻**）；`usePanelOpen(true, () => planId)` 让换计划回到展开
- [x] 10.5 删掉上一版的临时做法：`turnState` 的 `collapsed` / `togglePlanDetail`、`toggle-detail` 事件与两条渲染面的 5 层透传、`useWebAssistant` / `index.ts` 的 `togglePlanDetail`（折叠不再是回合边界状态）
- [x] 10.6 导出 `PanelSection` 与 `usePanelOpen`（宿主自写 panel 时能复用同一套壳与收缩逻辑）
- [x] 10.7 测试：删掉 `turnState.test.mjs` 里的折叠用例，新增 `test/usePanelOpen.test.mjs`（默认值 / 切换 / 同身份不重置 / 换身份回到 defaultOpen，含默认收起的面板）
- [x] 10.8 spec：Requirement 改为「过程与计划是两个同构的 panel」+ 3 个 Scenario（折叠头同构 / 折叠只收详情且主操作常驻 / 换计划回到展开）—— ⚠️ "主操作常驻"这条在 §11 被验收反馈推翻（改为"收起 = 只剩折叠头一行"，见 §11.8 的 spec 重写）

## 11. 面板同构的第二轮（验收反馈「计划执行中面板与过程面板是同级的，样式不太一样，而且「修改计划」按钮没收起」）

现象（headless Chrome 实测）：过程区折起来 29.5px 一行，计划卡折起来 74px = 折叠头 32.7 + **按钮行 40.4（占 55%）**；
两个折叠头也不等高（32.7 vs 28.5），执行中的计划面板还整体 `opacity: .92`；`flex: 0 0 auto` 只写在过程区那侧，
8 步计划在 480px 高的 dock 里被压扁、内容溢出盖住消息区。

- [x] 11.1 `src/components/PanelSection.vue`：`#footer`（动作条）从"常驻"改为**随详情收起**（放进 `v-if="open"` 分组；动作条在详情之外，主操作不被详情滚走）→ 收起 = 只剩折叠头一行
- [x] 11.2 `src/composables/usePanelOpen.ts`：`defaultOpen` 支持 **getter**（默认值本身是状态时用）。值真的变了才跟随（Vue 比 `Object.is`），值没变则不动 `open` —— 不弹回用户的手动折叠；静态默认值 + 无 `resetKey` 时不挂多余 watcher
- [x] 11.3 `src/components/PlanCard.vue`：`usePanelOpen(() => !approved.value, () => planId)` —— 待确认展开 / 执行中收起，点「开始执行」后自动收成一行、修订回来又展开；`.plan-card.approved { opacity: .92 }` 去掉（`.approved` 保留为宿主样式钩子）；`line-height: 1.7` 只作用于详情内容
- [x] 11.4 `src/components/PanelSection.vue`（壳负责"同构的那几行"）：`.panel { flex: 0 0 auto; font-size: 12px }`、`.panel-head { line-height: 1.5 }`、`.panel-body { max-height: var(--wa-panel-body-max, 200px); overflow-y: auto }`；修 `.panel-toggle:hover :slotted(.title)`（原写法编译成 `.title[data-v-壳]`，slot 内容上没有这个属性 → 悬停标题不变色）
- [x] 11.5 `src/components/PlanCard.vue`：徽标药丸加 `line-height: 1.4`（11px + 2px padding 比折叠头标题行还高 0.5px → 计划头比过程头高 1px）
- [x] 11.6 删掉重复：`TraceTimeline` 的 `.list { max-height: 200px }`、`ChatPanel` / `HostAssistantChat` 各一份的 `.trace-panel { flex: 0 0 auto }`
- [x] 11.7 测试：`test/usePanelOpen.test.mjs` 补两例（getter 默认值跟随 / 值没变不弹回手动折叠）；新增 `test/render-panel.mjs`（SSR 结构验收 8 项：执行中收起无详情无动作条 / 待确认有步骤与两按钮 / 修订输入态 / 两处壳同构 / 修订提示常驻）+ `package.json` 的 `test:render:panel`
- [x] 11.8 spec：Requirement「过程与计划是两个同构的 panel」改为「折叠粒度一致（收起 = 一行）+ 默认折叠值跟随状态 + 详情限高滚动」+ Scenario 重写（折叠 = 只剩一行 / 点开始执行自动收起 / 待确认展开 / 换计划回默认）
- [x] 11.9 实测收口（headless Chrome 量布局）：两处折叠头都精确 **30px**（面板都 31px）、`flex-shrink: 0`、`opacity: 1`；8 步计划在 480px 高 dock 里详情内部滚动（`scrollHeight 207 / clientHeight 200`）、输入栏仍在视野内（`contentOverflow = -1`）
