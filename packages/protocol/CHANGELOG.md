# @webassistant/protocol

## 0.6.0

### Minor Changes

- f911e93: 计划中的人工步骤（人机交接）：`handoff_step` 把 agent 做不了的一步交回用户，用户点「我已完成，下一步」才推进

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

## 0.5.0

### Minor Changes

- 8a2f9e3: 模式与回合边界：act / plan / auto + 计划卡 / 提问卡 / 进度交接（`add-agent-modes-and-plan-turns`）

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

- 8a2f9e3: 计划的交互式修订：改计划不再推倒重来（`add-interactive-plan-revision`）

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

- 9faad13: 过程与结果分离：思考走独立通道、过程步骤带起止与耗时

  修的是「思考的过程与结果没有区分的开」这一类问题 —— 根因是 `useAgentChat` 把过程行以
  `\n> …\n` 追加进**同一条** assistant 消息的 `content` 里，UI 只拿到一根字符串，没有任何
  字段可区分（且旧客户端不解析 markdown，`>` 就是字面的大于号）。

  ### protocol（加法变更，向后兼容）

  - `chat.text` 新增可选 `channel?: 'text' | 'reasoning'` —— 结果正文与**模型思考**分走两个通道。
    用可选字段而不是新增 `chat.reasoning` 消息类型：旧客户端会把 reasoning 增量当普通文本渲染
    （内容不丢、不崩），只是不分栏。
  - `agent.step` 新增可选 `phase?: 'start' | 'end'` / `tool` / `target` / `args` /
    `ok` / `error` / `durationMs` —— 过程步骤可「闭合」（成败 + 耗时），文案带动作目标。
  - `chat.done` 新增可选 `startedAt` / `durationMs` —— 过程区标题的「共 N 步 · X.Xs」。

  ### chat-client

  - **新增 `ChatMessageKind`**：`ChatMessage` 加可选 `kind?: 'message' | 'reasoning' | 'step' | 'error'`
    与 `at` / `tool` / `target` / `args` / `settled` / `ok` / `error` / `durationMs`。
    `kind` 缺省仍是结果气泡 —— 老宿主自造的消息行为不变。
  - **`useAgentChat` 分行**：流式游标按通道各持一个；`agent.step` 独立成条并按 `phase` 就地结算；
    删除三处硬编码的 `> 正在打开页面…` 过程行（过程文案唯一来源改为 server 的 `agent.step`）。
    新增返回 `bubbles` / `trace` / `traceSummary`。
  - **新增 `lib/chatTrace.ts`**（纯逻辑）：`appendStream` / `pushStep` / `splitMessages` /
    `summarizeTrace` / `mergeTimeline` / `buildTraceRows` / `formatDuration`。
    `mergeTimeline` 把 agent 步骤与 runtime 活动**合并去重**（同一步不再显示两行）。
  - **新增 `TraceTimeline` 组件**：过程区（步数 / 进行中 / 失败 / 耗时摘要，步骤行带 ✓/✗/◐ + 耗时，
    失败原因就地显示，思考渲染成灰色斜体块），流式期间的「思考中…」指示器也收进这里。
  - **`HostAssistantChat` / `ChatPanel`**：按 `kind` 分流渲染，结果气泡只放结果；
    删掉各自独立的「思考中…」气泡（消除同一面板里的重复提示）。新增可选 props
    `showTrace` / `traceDefaultOpen` / `traceDurationMs` / `activities` / `includeActivities`。
  - **`HostAssistantDock`**：过程区改用 `TraceTimeline`（agent 步骤 + runtime 活动合并），
    原 `showActivities` / `activitiesDefaultOpen` 语义保留。`HostAssistantActivities` 继续导出
    （纯 runtime 活动折叠条 + 清空，可单独复用）。
  - **`WebAssistant`**：渲染区与提示条不再重复「Agent 思考中…」（保留「打断」控制）。
  - 新增 `--wa-trace-bg` / `--wa-trace-text` 主题变量。

  测试：`test/chatTrace.test.mjs`（纯逻辑）、`test/agentChat.test.mjs`（假 socket 的贯通链路）、
  `test/render-split.mjs`（SSR 渲染结构，`pnpm --filter @webassistant/chat-client test:render`）。

## 0.4.0

### Minor Changes

- 7c0d8b2: 路由入参通道显式化：path 之外还能声明 query 参数（页面写 `route.query.x` 也能被 agent 传参驱动）。

  - **`protocol`**：`ManifestParam` 新增 `in?: 'path' | 'query'`（缺省 `path`，**path 参数不写该字段** ⇒ 旧 manifest / 手写 manifest 完全兼容）与 `description`；
    `WcPageEntry` 新增 `query?: Array<Omit<ManifestParam, 'in'>>` 显式声明逃生口（**可选**；通道固定 query —— 动态键 / 模板不可见 / 想覆盖说明或类型）。
  - **`analyzer`**：新增 `src/routeScan.ts` —— 纯 AST 探测页面源码里的 `route.query.x` 读取
    （`useRoute()` 绑定名 / `{ query: q }` 别名 / `route.query['x']` / `const { x: alias } = route.query` / 内联 / 模板 `$route.query.x`），
    带类型推断（同名 props > 包装调用 > 兜底字面量 > 恒等比较 > `string`）与诊断（动态键 / 整块读 / `route.params.x` 与 path 不一致）；
    查询参数的 `description` 只取声明处注释的**第一行**（续行是开发者向说明，不出网进 prompt），诊断按通道指路
    （params 不一致 → 补 path 段位或改读 query），显式声明与 path 段同名时提示「会形成双通道两条入参」；
    `resolvePageParams()` 是 analyzer 与 `vite-plugin-wc` 共用的装配入口（顺手消掉两份重复的 `extractParams`）；
    `AiPageResult` 新增 `paramDescriptions`（AI 只给已探测到的参数补说明）。
  - **`wc-runtime-core`**：`resolve()` 按 `route.params[].in` 把 agent 的 `params` 分流到 `location.query`（值收口 `string` / `string[]`），
    未声明的键保持旧行为；`sameLocation()` 计入 query（query 变化 = 新导航，back 能回到上一个筛选条件）；
    `resolveProps()` 让声明过的 prop 从 `params ?? query` 取值，但不把未声明的 query 键写进 props（避免污染元素属性）。
  - **`vite-plugin-wc`**：manifest 生成改用 analyzer 的 `resolvePageParams`，两条构建路径不再各算一套。
  - **`chat-client` / `wc-runtime-vue`**：无需改动（`location.query` 早已被容器 memory router 桥与宿主真实 router 桥消费）。
  - **`agent-server`**（未发版）：prompt 参数按通道分段（`路径参数：` / `查询参数：`）+ 一条「两种通道都放进 `render` 的 params」规则句。

## 0.3.0

### Minor Changes

- feat(demo): demo-app 重写为展示应用 + `wc.pages.json` 可声明 `dataSources`

  - **protocol**：`WcPageEntry` 新增 `dataSources?: ManifestDataSource[]` —— 数据源声明的**单一来源**
    回到清单文件（此前只能手改产物 manifest，下次 `pnpm analyze` 会被冲掉）。
  - **analyzer**：把页面条目的 `dataSources` 原样写进 `manifest.pages[].dataSources`（未声明不写字段）；
    单测覆盖透传与「未声明即省略」。
  - **demo-app 重写为展示应用**（业务页干净、探针集中进 `/lab`）：
    - 新增 `src/api/*`（每个资源一个模块，上报调用点收拢在这里）、`src/layout/AppShell.vue`、
      `src/styles/tokens.css`（兼作 chat-client 主题变量）、`api/query.ts` 等。
    - 页面重写：`Dashboard` / `UserList` / `UserDetail` / `OrderList` / `DatasourceAdmin` / `Settings` /
      `Lab`（新）/ `Login`（新，宿主自己的路由，演示登录守卫 + token）；删除 `AppDashboard` /
      `ProductList` / `GraphDemo`（并入 Lab）/ `TestCmp`（并入 Lab）/ `data.ts`。
    - `serve.mjs` 重写为小型 mock 后端：用户/订单/指标/数据源 CRUD + 分页筛选 + `?fail=500|401|slow`
      错误注入 + `/api/settings` 需要 Authorization。
    - 清单重写：`wc.host.json` / `wc.pages.json` 均声明 `dataSources`（如 `/api/users` 只暴露
      `id/name/role` 且 `maxRows: 6`），路由与 manifest 的 `name` 严格对齐。
    - 上报口径保持「调用点显式」：带 `reportData(source, data, { url })` 才走白名单裁剪；
      失败路径也上报（`*-error`，刻意不带 url 以免被字段白名单裁空）。
    - 文档：新增 `packages/demo-app/README.md`（页面 ↔ 能力映射 + 验收清单）；同步 PROJECT.md / README.md /
      `rules/domain.md`。

- feat(session)!: 会话改为 connection-scoped（会话 = 连接）—— 断开即新会话，并在连接内实现真正的多轮对话

  **破坏性变更**

  - 协议（`@webassistant/protocol`）：
    - `SessionHelloMessage` 删除 `sessionId?`（客户端不再上报、不再持久化任何会话标识）；
    - `SessionReadyMessage` 删除 `resumed`（每次都新建会话，没有"恢复"这个状态）；
    - `AgentSession` 删除 `history`（只写不读的死数据）与 `socketId`（连接作用域后无需绑定/解绑判定），
      随之删除 `ChatTurn` / `ChatTurnRole` 类型。
  - chat-client：
    - `createAgentSocket` 不再读写 `sessionStorage`（`webassistant.sessionId` 键消失）；
    - `connect()` 返回值由 `{ sessionId, resumed }` 改为 `{ sessionId }`；
    - 新增 `AgentSocket.startNewSession()` 与 `AgentSocketOptions.onSessionReset`；`useWebAssistant` / `useAgentChat`
      透出 `startNewSession()`。

  **原因**

  原设计是「会话与连接解耦」（`sessionId` 存 `sessionStorage`、断线重连恢复），但实际运行中它带来的是负收益：

  1. **前后端状态必然发岔** —— 刷新后客户端渲染宿主回到欢迎页（不发 `page.navigated`），服务端却仍保留刷新前的
     `currentPage` / `recentObservations` / `pageExposedKeys`，下一轮 prompt 会告诉模型一个并不存在的"当前页"。
  2. **刷新后旧 run 继续串流，还能并发起第二个 run** —— `activeAgents` 按 sessionId 保活、`rpc.register` 覆盖式注册，
     于是旧 run 的输出继续推到刷新后的页面；此时再发消息会跑起两个并发 Agent，且旧实例的引用被覆盖后**再也 cancel 不掉**。
  3. **"多轮对话"其实不存在** —— `session.history` 只写不读，`new Agent()` 也没带 `initialMessages`，
     每轮都是单轮无记忆对话。也就是说"保持 session"保住的只是陈旧页面上下文，没保住对话本身。

  **改为**

  - **会话 = 连接**：握手即新建、断开即销毁；客户端零持久化（刷新 / 重连 = 全新会话，聊天区清空并提示）；
    多条 WS 连接并存时各自独立会话。
  - **断开即止损**：`handleDisconnect` 依次 abort 在跑的 run → 销毁会话（含清理观察等待）→ 注销 RPC → 释放 agent 实例。
  - **连接内真多轮**：`AgentService` 为每个会话维护一个长驻 `AgentRuntime`（`state.messages` 即对话轨迹，
    含 tool-call / tool-result）；每轮的动态页面上下文（manifest + 规则 + 当前页可用方法 + 最近观察）
    由 SDK 的 `prepareTurn` 投影注入（只影响当次请求、不回写轨迹），并按 `MAX_TURN_MESSAGES`（默认 24）做有界裁剪。
  - **同会话串行**：运行中再次 `chat.send` 会被显式拒绝并回 `chat.error`（SDK 侧也有 "already running" 保护）。
  - `SESSION_TTL_MS` 保留为**僵尸兜底回收**（异常路径未触发 disconnect 时），不再承担"保活"语义。
  - 客户端新增「新会话」入口（内置 `ChatPanel` 标题栏按钮），等价于刷新页面但不必关标签页。

  **迁移**

  - 自定义宿主若曾读取 `session.ready.resumed` 或自行持久化 `sessionId`，直接删除相关逻辑（协议不再提供）；
    旧服务端 + 新客户端、或新服务端 + 旧客户端都能工作（服务端忽略入参 `sessionId`，客户端不读 `resumed`）。
  - 需要"记住上次会话"的场景不再支持：刷新即新会话是本版本的**有意行为**。

## 0.2.0

### Minor Changes

- 258d331: refactor(observe)!: 退役自动网络观测 —— 数据只由调用点显式 `apiBus.report` 上报

  **破坏性变更**

  - 删除 `NetworkObserver`（不再包装 `window.fetch` / `XMLHttpRequest`）与 `CreateRuntimeOptions.observeNetwork`；
    随之删除各类型/句柄上的 `observer` 字段、`network-observation` 事件、`WcActivityKind` 的 `'network'`。
  - 协议删除 `page.network.request|response|error|timeout` 四条客户端消息与 `PageNetwork*` 类型、
    `AgentSession.pendingRequests`；`ObservationMatch` 由 `requestId/method/url` 改为 `source/event/contains`。
  - chat-client 删除 `onNetworkObservation` / `sendObservation`。
  - **数据上报只有一条路**：调用方（宿主 / 页面）在需要的调用点显式 `apiBus.report({ source, data })`；
    **不调 = 零数据出浏览器**（天然 fail-closed，无需维护白名单）。

  **原因**：全量拦截宿主页面的请求（真实站点往往有大量内部接口）会把不相关甚至敏感的数据带出浏览器，
  而靠事后白名单 / 脱敏补救既不可靠（fetch 分支曾漏检黑名单）、也难以维护；同时改写全局 fetch 还带来
  阻塞流式响应、多实例抢占、`stop()` 后残留包装等副作用。

  **其他改动**

  - `apiBus.report()`：`url` 改可选、新增 `source`；返回 `boolean`（false = 当前无人监听）。
  - `apiBus.attach()` 增加**覆盖告警**（单 sink 语义）：业务侧误调 `attach()` 顶掉内核 sink 时立刻可见。
  - **chat-client 转出 `apiBus` / `ApiReport`**：只装面板的宿主（用法 A）不必为了上报再引一个包。
  - `sanitizeData` 从 `observer.ts` 搬到 `sanitize.ts`，并修掉 O(n²) 的体积统计（现为线性、上限更可预期）。
  - runtime 侧对上报数据只做：补 `page`/`at` + 体积/深度硬上限（16KB / 深度 4）+ **可选**的
    `dataSources` 裁剪（命中才裁；未命中即原样透传）。
  - `wait_for_observation` 工具描述与匹配条件改为「等待显式上报的数据 / 页面事件」。

  **迁移**：把原来的自动上报（如 axios 拦截器里统一 `apiBus.report`）改为在**明确的调用点**上报，
  并只传你愿意公开的字段；页面/宿主未调用则 agent 侧不会收到任何业务数据。

## 0.1.1

### Patch Changes

- 7e86e8d: 新增「用法 B：宿主直连」—— agent 直接操作宿主自己的 vue-router，页面在宿主自己的 `<router-view>` 渲染（不编译 WC、不建容器、不做样式隔离）。

  - **wc-runtime-core**：把 runtime 拆成「内核（kernel.ts）+ 渲染面（PageSurface / RuntimeHistory 两个扩展点）」，
    `createRuntime({ surface: 'container' | 'host' })` 选择渲染面；默认 container **行为与解耦前等价**（既有单测断言零改动）。
    容器实现迁入 `surfaceContainer.ts`；manifest 归一化支持宿主批次（`bundle` 可省、`containers` 可空、`tag` 无需含 `-`）；
    新增 `surface` / `hostSurface` / `adopt` 选项，`init(root?)` 允许不传挂载点；`RuntimeHistory` 支持外部历史（委托宿主）。
  - **wc-runtime-vue**：抽出 `routerSync.ts`（guard 前移 / `applying` 防回环 / 回流 commit，两种用法共用一份）；
    新增 `createVueHostSurface()` 与 `createVueHostRuntime()` 及子入口 `@webassistant/wc-runtime-vue/host-router`；
    `RuntimeServicesContext` 新增 `pageProps` 旁路（container 模式恒为空）。
  - **chat-client**：新增 `surface` / `createRuntime` 注入口与 host 模式面板（无渲染区，只显示状态）；
    `useRuntimeHost` 允许无挂载点初始化；单实例约束告警。
  - **protocol / analyzer / vite-plugin-wc**：`wc.pages.json` 的 `container` 变为可选 —— 省略即宿主直连批次，
    analyzer / `wcManifestPlugin` 不再写 `containers` 与 `pages[].bundle`（WC 构建侧仍强制要求 container）；
    `ManifestPage.bundle` 变可选。
  - **demo-app**：新增 `host.html` + `src/host-main.ts` 验收台与 `pnpm dev:host` / `pnpm analyze:host` 脚本。

## 0.1.0

### Minor Changes

- 31df00c: **项目规则：`wc.pages.json` → `manifest.rules` → system prompt**（两级规则文档，改规则无需重启 agent-server）

  - **`analyzer`**：新增 `rules.ts`（`resolveRuleEntries`）—— 把 `wc.pages.json` 的 `rules` 声明
    （文件路径 / 目录（自动收集 `.md`、按文件名排序）/ 内联 `{ name, content }`，支持 frontmatter
    `name` / `disabled`，字段对齐 Cline SDK 的 `RuleConfig`）解析成 `ManifestRule[]`；
    **analyzer 与 `vite-plugin-wc` 共用同一实现**，避免两条生成路径漂移。
  - **`protocol`**：新增 `ManifestRule` 与 `manifest.rules` / `pages[].rules` 字段、`wcPages` 的 `rules` 声明类型。
  - **`vite-plugin-wc`**：manifest 增量生成接入 rules —— 指纹变化即重算；未声明但旧 manifest 有 `rules` →
    保留旧值（与 `dataSources` 同款「手工字段保留」，页面级同样适用）；dev watch 把规则文件/目录纳入监听，
    改动即增量重生成。
  - **agent-server**（不在 changeset）：`ManifestService.getRules()` + `buildAgentContext()` 把 manifest 级规则
    拼进 system prompt 的「项目规则」段（**优先于通用规则**）、页面级规则拼在「可用页面」列表里对应页面条目下
    （跳过 `disabled`）；本地 manifest 走 mtime 热重载、远程走定期刷新。

- 31df00c: **欢迎页 = 渲染区空态**（runtime 没有渲染子 WC 时渲染区的默认内容）：逻辑对外开放，宿主可整体覆盖。

  - **`wc-runtime-core`**：新增 `Runtime.hasPage`（有当前页 ⇔ 已渲染出子 WC，与 `RuntimeView.tag` 同源；
    `false` 时宿主应展示空态）。`initial: null` 不导航 → 天然 `false`，不再需要宿主自己记「导航过没有」。
  - **`chat-client`**：欢迎页拆三层并全部导出 ——
    - `lib/welcome.ts`（纯逻辑、零依赖、可单测）：`DEFAULT_WELCOME_TEXT`、`resolveWelcomeVariant`
      （`page` / `welcome-loading` / `welcome`）、`resolveWelcomeLoading`、`resolveWelcomeText`、
      `resolveWelcomeCapabilities`（握手载荷优先，本地 manifest 路由兜底）、`resolveWelcomeComponent`。
    - `composables/useWelcomePage.ts`：包成 `{ variant, visible, text, capabilities, loading }`；
      `useWebAssistant()` 以 `welcomePage` 透出（原先 headless 宿主只能自己再抄一遍判空与合并）。
    - `components/WelcomePage.vue`：默认呈现组件（`text` / `capabilities` / `loading`）。
  - **判空改用 runtime 事实**：`useRuntimeHost` 订阅 `view` 事件派生 `currentTag` / `hasPage`，不再用
    `navigate` 事件的粘性布尔（后者只表示「发生过导航」，加载失败不回退，且一旦导航过就再也回不到空态）。
  - **错误与欢迎页解耦**：错误独立成横幅（新增 `--wa-error-*` 主题变量），不再把空态整块替换成一行错误文本；
    有页面时错误也不再不可见。
  - **`loading` 语义修正**：由 `sessionReady` + `manifestSettled` 决定（**失败也算 settle**，不会死转圈），
    不再是「对话中」；刷新瞬间不会误显「暂无可操作页面」。
  - **修复「内置欢迎页永不渲染」**：`welcome` 的运行时 prop 含 `Boolean` 且无 `default` 时，Vue 会把缺省
    cast 成 `false`（runtime-core：`isAbsent && !hasDefault → value = false`）→ 被误判成「宿主关闭了欢迎页」，
    渲染区只剩最小空态。修法：`withDefaults` 显式 `welcome: undefined`（产物核对 `default: void 0`），
    并新增 `resolveWelcomeComponent` 兜住非组件值（`true` / 空串 → 回退内置组件）。
  - **覆盖优先级不变**：`#welcome` 插槽 > `welcome` prop > 内置 `WelcomePage` > `welcome=false` 最小空态；
    `#welcome` 插槽入参升级为**合并后的完整状态**（`WelcomePageSlotProps`）。
  - **`protocol`**：`session.ready.welcome = { text, capabilities[] }`（`WelcomePayload` / `WelcomeCapability`），
    随握手一并下发，供欢迎页渲染能力卡片；缺失时客户端用本地 manifest 路由兜底。
  - **首屏默认不自动打开页面**：`initialPage`（`boolean | string`）显式化；缺省 = 欢迎页先出现。
