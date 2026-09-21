# 设计：计划的交互式修订

## Context

「回合边界」这套状态机（`add-agent-modes-and-plan-turns`）把三件事统一成
「收尾工具结束本轮 → session 记状态 → 推结构化卡片 → 用户回应经下一次 `chat.send`」：
计划确认（`planId`）、澄清提问（`questionId`）、进度交接（`finish_turn`）。

但**计划的"改"没有自己的表达方式**：

- 协议里 `chat.send` 只有 `planId`（确认）与 `questionId`（回答），没有"修改"这个意图位；
- 修订只能用 `propose_plan` 表达，而它的语义是**新计划**（`buildPlan()` 生成新 `planId`，
  `session.recordPlan()` 把旧计划标 `superseded`）—— 于是"改一步"必然退化成"换一份计划"，
  已完成的步骤全部回到 `pending`；
- `PlanStep.id`（`protocol/src/session.ts:55`）声明为「会话内稳定标识」，但 `propose_plan` 的入参
  steps 只有 `{title, detail}` ——模型**无法引用**既有步骤，同一性在协议层不可表达；
- 门禁判据是 `session.plan.approvedAt`（`agent.service.ts:442`），所以"改动计划"与"批准状态"
  必须显式对齐，否则会出现"计划已改、门禁还开着"。

## Goals / Non-Goals

**Goals（本次做到）**

1. 用户能在计划卡上**写下具体修改意见**，并作为"修订意图"（`chat.send.revisePlanId`）下发。
2. 修订由**专用收尾工具 `revise_plan`** 产出，服务端按 **step id 增量合并**：改标题/详情、保留状态、
   新增取号、删除、重排；`planId` 不变、`revision+1`。
3. 修订是**服务端保证**的"不推倒重来"：修订轮里 `propose_plan` 被硬拦。
4. 修订结果**原地更新同一张卡**（含"第 N 版 + 变更摘要"），并**重新要求确认**（已批准计划被改动即回到
   `proposed` 且清空 `approvedAt`）。
5. 全量重来仍可用（次要入口「重新生成计划」→ 既有 `propose_plan` 路径）。

**Non-Goals（本次不做）**

- 不做"自动接力"（`AUTO_CONTINUE_MAX_TURNS`）与 `MODE_CLASSIFIER=llm`（仍是 TODO 里的后续项）。
- 不做步骤级局部重写（"只重写第 2 步，其他别动"）之外的**富编辑 UI**（拖拽排序、双击改名）。
  Reorder 只需模型在入参里调整顺序即可，UI 不提供拖拽。
- 不持久化计划（会话 = 连接，与既有语义一致）。
- 不为旧客户端做兼容迂回（同上次变更 D8 的取舍）。

## Decisions

### D1 修订是**新收尾工具** `revise_plan`，而不是给 `propose_plan` 加参数

**决定**：新增 `revise_plan({ note?, summary?, steps[] })`，与 `propose_plan` 并列（同为 `lifecycle.completesRun`）。

**为什么**：`propose_plan` 的语义是"我建议一份**新**计划"，修订的语义是"在**现有**计划上改"。
两者一旦混在一个工具里，服务端就没法对"这轮到底该合并还是该替换"做确定性判断（只能靠模型在入参里
自陈意图，等于把关键判断交给最不可靠的一环）。分开之后，"修订轮禁止 `propose_plan`"这条硬保证才成立。

**替代方案**：`propose_plan({ summarize, steps:[{id?}] })` 复用 —— 少一个工具名，但语义混沌、无法硬拦，
且 `propose_plan` 的既有描述（"不要把一句话任务拆成计划"）会与修订语义互相污染。已弃。

### D2 步骤同一性用 `PlanStep.id`，不用标题匹配

**决定**：`revise_plan` 的步骤可带 `id`；带 id = 原地修改（保状态），省略 = 新增。

**为什么**：修订最常见的一种改动就是"改这一步的表述"，用标题匹配等于把"改标题"判成"删掉旧的 + 加一个
新的" —— 状态（含 `done`）随之丢失，正是本变更要消灭的病症。协议里 `PlanStep.id` 本来就为此存在。

**替代方案**：标题/序号位置匹配 —— 改标题或重排即失配，故弃。

### D3 `planId` 不变 + `revision` 计数（而不是发新 `planId`）

**决定**：修订后 `plan.id` 保持不变，`revision = (原 revision ?? 1) + 1`，并记 `revisedAt`。

**为什么**：
- 客户端卡片延续（用户看到的"计划被改了"，而不是"旧卡消失 + 冒出一张陌生新卡"）；
- 不触发 `stale` 分支（`approvePlan()` 判的是 `plan.id !== planId`），用户改完能直接用同一张卡点「开始执行」；
- `Superseded` 语义（`session.recordPlan`）保留给真正"换计划"的路径（`propose_plan`）。

### D4 修订后重新对齐批准状态：已批准 → `proposed` 且清空 `approvedAt`

**决定**：修订前已批准的计划，修订后 `status = 'proposed'`、`approvedAt = undefined`；未批准的计划保持 `proposed`。

**为什么**：plan 门禁（`PLAN_GATE=hard`）的判据就是 `session.plan.approvedAt`。计划内容变了，
用户当初批准的那一份已经不存在了 —— 保留 `approvedAt` 会出现"改了计划但模型仍可操作页面"的安全漏洞，
是本变更里最不能错的一处。

**替代方案**：保留批准状态继续执行（少一次点击）—— 点击成本换安全边界，不值，且会让"门禁"这条既定保证失效。已弃。

### D5 未知 step id **抛错**，不静默忽略

**决定**：入参里出现当前计划不存在的 `id` → 工具抛错（SDK 标 `isError`，模型收到原因后可自纠），
计划与会话状态不变。

**为什么**：与既有 `normalizePlanArgs` / `normalizeAskArgs` 的既定做法一致（非法输入抛错让模型修正）。
"静默忽略"会造成最坏的一类 bug：用户说了改哪一步、服务端没改、界面却显示"已更新"。

### D6 修订轮硬拦 `propose_plan`（服务端保证，不只 prompt）

**决定**：`session.planTurn = { kind: 'revise', planId, text }` 存在时，`hooks.beforeTool` 对
`propose_plan` 返回 `{ skip: true, reason: '本轮是计划修改：请调用 revise_plan 并回填完整步骤（未改动的步骤保留原 id）' }`。

**为什么**：与 `PLAN_GATE` 同款哲学（"不许偷偷动手"是服务端保证）。prompt 里写了规则，但模型在
"用户提了修改意见"这种语境下很容易顺手再 `propose_plan` 一次；一旦发生，全量重生成就复现了 —— 那正是本变更要修的问题。

### D7 客户端以服务端 `status` 为准（`ChatPlanMessage.status` 新增）

**决定**：`chat.plan` 新增 `status`（`'proposed' | 'approved'`）、`revision`、`revisedAt`、`note`；
`lib/turnState.ts` 的 `applyPlan()` 跟随消息里的 `status`，不再一律重置为 `proposed`。

**为什么**：修订会出现"卡片已在本地被标成 approved，而服务端因修订把它回落成 proposed"这种**本地与服务端
方向相反**的迁移。让客户端**推断**（比如"同 planId 且 revision 变大就回落"）等于把产品规则复制两份、
迟早漂移；直接读服务端权威字段最省事、最可测。

**替代方案**：客户端按 `planId` 是否变化推断 —— 修订恰恰不改 planId，推不出来。已弃。

### D8 客户端交互：卡内输入 + 两个入口可区分

**决定**：`PlanCard` 次级按钮「修改计划」→ 卡内展开 `<input>` + 「提交修改」/「取消」；
已批准态也保留该入口；另给一个弱化链接「重新生成计划」（`emit('replan')` → 既有全量重规划路径）。
修订草稿态放在 `lib/turnState.ts`（纯函数：`beginPlanRevision` / `updatePlanDraft` / `cancelPlanRevision`），
组件只做 props/emit（与 `AskCard` 同款，"数据进、事件出"）。

**为什么**：两条渲染面（容器面 `ChatPanel` 与宿主直连面 `HostAssistantChat`）共用同一批组件，
把状态放进纯函数层才能一次改动同时覆盖两条面，并保持可单测。

**替代方案**：把输入框做成"点按钮后走主输入栏"（把焦点与文案塞进底部输入框）—— 需要跨组件协调焦点与占位文案，
且用户容易在别处误发；卡内输入更贴近"我就在改这一张卡"的心智。已弃。

### D9 折叠的粒度与默认值都由状态决定：收起 = 一行，待确认展开 / 执行中收起

**决定**：`PanelSection` 的 footer 槽（动作条）**随详情一起收起**（不再常驻）—— 折叠后 = 只有折叠头一行；
计划 panel 的默认折叠值**跟随 `status`**（`proposed` 展开 / `approved` 收起），
由 `usePanelOpen` 新增的 **getter 默认值**实现（默认值一变 `open` 就跟随，值没变则不动 —— 不弹回用户的手动折叠）。

**为什么改（原设计的取舍反了）**：原设计为了"主操作不能被折叠藏起来"（§10 / 第一版 spec）把按钮做成常驻 footer，
代价是**两个"同构"的 panel 折起来不是同一个东西**：过程区收起来是一行（29.5px），计划卡收起来是"一行 + 40px 按钮行"，
按钮行占折叠后高度的 55% —— 并排看，一个像折叠条、一个像一块卡。而"执行中"的计划本来就不再需要用户立刻做决定
（要改就点开），把按钮藏进详情里没丢功能，却换回了视觉与行为的一致。顺带收口另外三处漂移：

| 漂移 | 表现 | 收口 |
|---|---|---|
| 折叠头行高 | `PlanCard` 根上的 `line-height: 1.7` 漏进折叠头 → 计划头 32.7px vs 过程头 28.5px | 壳里给 `.panel-head { line-height: 1.5 }`；行高只作用于详情内容 |
| 执行中降透明度 | `.plan-card.approved { opacity: .92 }` → 同级两个 panel 底纹/分隔线深浅不一 | 去掉（"执行中"由徽标表达）；`.approved` 保留为宿主的样式钩子 |
| flex 行为 | `flex: 0 0 auto` 只写在过程区那侧（两条渲染面各一份 `.trace-panel`）→ 计划卡可被压缩，长计划把面板压扁、内容溢出盖住消息区 | `.panel { flex: 0 0 auto; font-size: 12px }` 进壳；删掉两处重复的 `.trace-panel` |
| 徽标药丸 | 药丸（11px + 2px padding）比折叠头标题行还高 0.5px → 计划头比过程头高 1px | 药丸自带 `line-height: 1.4` |

**代价**：折叠粒度改成"全收"后，详情区必须限高 + 内部滚动（否则长计划会把输入栏顶出视野）——
因此 `.panel-body { max-height: var(--wa-panel-body-max, 200px); overflow-y: auto }` 放进壳，
过程区自己的 `.list { max-height: 200px }` 随之删掉（口径只有一处）。

**替代方案**：把「开始执行 / 修改计划」移到折叠头右侧（像过程区的「清空」那样常驻）—— 收起时同样只有一行，
但要么把主按钮塞进 12px 的折叠头（视觉重量不对），要么在待确认态把主操作降级成文字链接；且它与"折叠 = 全收"
这条统一规则不一致。已弃（用户选择的方案 1）。

## Risks / Trade-offs

- **模型不回填 id（把旧步骤全当新增）** → 结果表现为"移除 N 步 + 新增 N 步"，进度仍会丢。
  缓解：① prompt 规则显式要求"未改动的步骤必须原样带回 id"；② 修订轮硬拦 `propose_plan`；
  ③ `describePlanChanges` 把"移除 M 个**已完成**步骤"写进用户可见文本与 `chat.plan.note`，
  用户与模型都能立刻看到异常（而不是静默丢进度）；④ 冒烟脚本断言 `step-1` 仍为 `done`。
  不做（本次）：零命中即拒 —— 会挡住"用户确实想整份换掉"的合法场景。
- **重排后 id 序号与位置不再一致**（`step-3` 可能排在第 2 位）→ 可接受：`id` 是标识不是序号；
  新增步骤取"当前最大序号 + 1"，保证不与既有 id 冲突。
- **修订后多一次确认点击**（执行中改计划）→ 有意的产品取舍（D4），spec 里显式化为一个 Requirement。
- **`ChatPlanMessage` 新增必填 `status`** → 旧客户端（若混用）会忽略新 `t` 之外的行为差异；
  本仓配套发布 + `.changeset` 标 BREAKING，符合既有取舍。

## Migration Plan

1. 协议先行：`protocol` 加字段与工具名（编译期即可发现所有需要跟进的投影点）。
2. `agent-server`：`turnEnd`（纯函数 + 单测）→ `session.revisePlan` → `agent.service`（工具与门禁）
   → `manifest`（prompt 段与规则）→ `traceText` / `gateway`。
3. `chat-client`：`turnState`（纯函数 + 单测）→ `useAgentChat.revisePlan` → `PlanCard` →
   两条渲染面接线与导出。
4. 收口：`pnpm typecheck` + `pnpm test`；冒烟 `SMOKE_EXPECT=...` 真调模型跑通"计划 → 修改 → 断言 planId 不变、进度不丢、revision=2"。
5. 回滚：本变更不涉及持久化数据（会话 = 连接），回滚即回退版本；无数据迁移。

## Open Questions

- 是否需要"修订历史"（保留 v1 供用户对比）？当前只留 `revision` 计数与变更摘要 `note`（不存历史），
  若后续需要对比，可在 `AgentPlan` 上加 `history[]`（连接作用域，成本低）。
- `reopen` 之外的步骤状态扩展（如 `blocked`）暂不引入 —— 需要新的 UI 语义，超出本次范围。
