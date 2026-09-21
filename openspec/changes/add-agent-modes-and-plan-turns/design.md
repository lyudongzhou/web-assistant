## Context

现状（相关代码事实）：

- 单轮 ReAct 上限来自 `agent-server/src/agent/agent.service.ts:31` 的 `MAX_AGENT_STEPS`（默认 6），透传给 `new Agent({ maxIterations })`。
- SDK（`@cline/agents` v0.0.77 的 `AgentRuntime.execute()`）在步数打满后 **`throw Error('Agent runtime exceeded maxIterations (N)')`**；该异常被 `catch` 转成 `status: 'failed'` → 服务端 `chat.error`。**「步数用尽」被实现成了「失败」**。
- 本项目**不使用** core 的内置工具装配（`act/plan/search/yolo` 那套 `S1` 模式表只决定 read_files/bash/editor/skills/ask_question 等内置工具是否装载），所以 **SDK 的 mode 对本项目完全无效** —— 模式必须自己实现。
- 会话是 connection-scoped（`session-per-connection`）：一个会话 = 一条 WS 连接，断开即销毁、不落盘；连接内多轮由长驻 `Agent` 实例的 `state.messages` 承载，每轮用 `prepareTurn` 投影动态上下文（manifest / 当前页方法 / 最近观察）。
- `protocol/src/session.ts:12` 的 `AgentRunStatus` 已声明 `'waiting-user'`，全仓从未使用。

已核实的 SDK 扩展点（决定了本设计的选型）：

| 扩展点 | 位置 | 语义 |
|---|---|---|
| `createTool({ lifecycle: { completesRun: true } })` | `@cline/shared` `AgentToolDefinition` | 该工具被调用即 `finishRun('completed', …)`，run 正常收尾（不是失败） |
| `hooks.beforeTool → { skip, reason, input, appendContext }` | `AgentBeforeToolResult` | `skip` 时**工具不执行**，模型收到 `{output:{error:reason}, isError:true}` → 可做**硬门禁** |
| `hooks.beforeModel → { messages }` | `AgentBeforeModelResult` | 只替换**当次** provider 请求的消息（不写 transcript）→ 可做"倒数一步"提醒 |
| `hooks.beforeModel → { stop: true }` | `applyStopControl` → `throw AgentRuntimeAbortError` | 结果状态是 `aborted`（服务端记作 `cancelled`）→ **不能**当软着陆 |
| `completionPolicy.requireCompletionTool` | `AgentConfig` | 模型不调收尾工具时注入 reminder 并 **continue**（会继续烧步数，仍可能撞上限）→ 不作主机制 |
| `consumePendingUserMessage` | `AgentConfig` | 迭代 ≥2 时把待注入用户消息并进当次请求（"运行中插话"）→ 保留为后续能力，本次不用 |

## Goals / Non-Goals

**Goals:**

1. 单轮步数用尽**永远不再表现为错误**：要么以 `finish_turn` 优雅收尾，要么降级为「已暂停」（可继续）。
2. 复杂任务**天然跨多轮**：`propose_plan` → 用户确认 → 分轮推进，每轮以 `finish_turn` 交接进度。
3. 信息不足时 agent 能**主动提问**（2~5 个选项），用户一次回答即可续跑。
4. 模式可控且可见：`act` / `plan` / `auto`（默认 auto，agent 自判），UI 上随时看得到当前生效模式与判定来源。
5. 计划未确认前**不得操作页面**（硬保证，不只靠 prompt）。

**Non-Goals:**

- 不做阻塞式提问（run 内挂起等用户），不做"运行中插话"（`consumePendingUserMessage`）。
- 不做计划的在线编辑 / 拖拽排序（MVP 只支持"开始执行 / 重新规划"）。
- 不做自动接力（服务端 run 结束自动起下一轮）——本轮只做"用户点继续"，自动接力留 `AUTO_CONTINUE` 开关位。
- 不做跨连接持久化：计划与提问状态随连接销毁（与 `session-per-connection` 一致）。
- 不为旧 `chat-client` 版本做协议降级（新 `t` 旧端会忽略；本仓配套发布，changeset 标 breaking）。

## Decisions

### D1 模式在服务端实现，而非复用 SDK mode

**决定**：模式 = ①`prepareTurn` 注入的规则集 ②`hooks.beforeTool` 的服务端门禁 ③回合推进策略；判定结果存 `session.mode`。

**为什么**：SDK 的 mode 只作用于内置工具装配，本项目不装载那些工具，传 `mode` 没有任何效果。把"模式"做成本项目自己的三件事，才能真正控制行为（尤其门禁必须能拦截我们的 `render`）。

**备选**：把 `act` / `plan` 做成两个不同的 `Agent` 实例（工具集不同）——否决：长驻实例跨多轮复用（`state.messages` 是对话上下文），换模式重建实例会丢上下文。

### D2 三个收尾工具（`lifecycle.completesRun`），都走 session 不走 RPC

**决定**：`propose_plan` / `ask_user` / `finish_turn` 三个 `createTool`，`lifecycle: { completesRun: true }`，`execute` 内只更新 session + 返回结构化载荷（**不** `rpc.call`）。

**为什么**：
- `completesRun` 是 SDK 唯一"优雅收尾"的机制（`findCompletingToolMessage` → `finishRun('completed')`），这是把"步数用尽 / 需要用户"从"失败"变回"正常状态"的关键。
- 不走 RPC：这三个动作**不需要浏览器执行任何东西**（计划卡 / 问题卡是服务端主动推的展示，不是前端要执行的动作），走 RPC 反而要处理超时与 pending 配对。

**备选**：复用 `tool.call`（把问题当 RPC 推给前端）——否决：会与 `rpc.pending` 配对耦合（前端必须 ack），且语义上"提问"不是"让前端做事"。

### D3 硬门禁放 `hooks.beforeTool`

**决定**：plan 模式且 `session.plan.approvedAt == null` 时，对 `render` / `call_page_method` 返回 `{ skip: true, reason: '计划尚未确认…' }`。

**为什么**：`skip` 是唯一"工具不执行"的机制（已核实：`if(e.skipReason) r={output:{error:...},isError:true}`）。拦截发生在**同一轮内**（不额外消耗 LLM 调用），模型看到 error 后会自然转向 `propose_plan`；`reason` 里写清解锁方式即可避免死循环。

**备选**：`appendContext` 软提醒（仍放行）——否决：不是保证，模型可能无视并直接操作页面（正是要避免的"计划模式下偷偷动手"）。`{ stop: true }` —— 否决：会被记成 `cancelled`。

### D4 `auto` 三层判定：显式 > 启发式 > 模型自判

**决定**：`mode.ts` 纯函数 `resolveMode({ requested, text, session, manifest })`：
1. `requested` 为 `act` / `plan` → 直接采用（`decidedBy: 'user'`）。
2. `requested` 为 `auto` → 启发式：多目标 / 并列 / 批量 / 对比 / 逐个 / 报表等信号词、提到多个页面 tag、跨多个数据源 → `plan`；命中单一页面 keywords 且无缺参 → `act`；否则返回 `undefined`（交第 3 层）。
3. 启发式不确定 → 采用 `plan`-倾向的 prompt（"简单就直接做，否则先 propose_plan"），由模型在第一轮自选工具；`decidedBy: 'model'`。

**为什么**：层 1 零成本且 100% 可控；层 2 纯函数、可回归测试、零 LLM 成本（比"再来一次分类调用"便宜且可解释）；层 3 把不可判的交给模型 —— 而模型选错时**服务端门禁**只会造成"多出一个计划卡"（用户点一下开始即可），不会造成误操作。`MODE_CLASSIFIER=llm` 作为后续开关位预留。

**模式要落到 prompt 上（验收补充）**：模式不只是门禁开关，还必须在 `buildAgentContext` 里**分工说明** ——
`act`（直接执行）下明确写"不要调用 propose_plan，直接操作页面，一轮推进不完就用 finish_turn 交接"。
这条是端到端验收时补的：只做门禁时不禁止 `propose_plan`，模型会在用户明确选了"直接执行"后**照样弹一张计划卡**
（把选择权又塞回用户）。`plan` 模式下则相反：未确认计划时提示"必须先 propose_plan，操作页面会被拒绝"。

**备选**：全部交给模型自判（不确定时不加任何倾向）——否决：简单任务也常被拆成计划，体验退化。一次轻量 LLM 分类调用 —— 本次不做（多一次请求 + 需超时兜底），留开关位。

### D5 回合边界统一为「收尾工具 + 下一次 `chat.send`」

**决定**：三种交互（计划确认 / 澄清提问 / 进度交接）都是：本轮 run 由收尾工具 `completed` → `session` 记 `plan` / `pendingQuestion` 并置 `activeRun.status = 'waiting-plan' | 'waiting-user'` → 服务端推 `chat.plan` / `chat.ask` → 用户操作经 `chat.send({ mode?, planId?, questionId? })` 起下一轮。

**为什么**：一套状态机覆盖三件事；不需要"loading 中允许回答"的特殊态（run 已结束，输入框天然可用）；不受 `AGENT_RUN_TIMEOUT_MS` / 步数约束；与 connection-scoped 语义一致。`waiting-*` 只是**上一轮的结束状态标记**（不是"run 还活着"），UI 据此在输入区上方显示卡片与提示。

**备选**：阻塞式提问（`ask_user` 走 `rpc.call` 等用户，答案以 tool-result 回到同一 run）——否决：会把一个开放式 run 挂在那里（需额外超时兜底），且需要改 `gateway` 的并发拒绝逻辑与 `loading` 语义。

### D6 步数软着陆：`beforeModel` 倒数一步提醒 + 失败降级

**决定**：
- `hooks.beforeModel`：`snapshot.iteration >= MAX_ITERATIONS - 1` 时，把 `[SYSTEM] 本轮步数即将用尽…请立刻调用 finish_turn 收尾` 追加到 `request.messages`（只影响本次请求）。
- 若仍撞上限：`agent.service.ts` 识别 error message 含 `exceeded maxIterations` → 视为**暂停**（`chat.done` + 一条助手文本「本轮步数已用尽，已暂停；回复"继续"接着做」），不发 `chat.error`。
- `MAX_AGENT_STEPS` 默认 6 → 12（配合软着陆，仍然是"有限预算"）。

**为什么**：模型无法感知剩余步数，只能由服务端告诉它；`beforeModel.messages` 恰好是"只影响当次请求"的投影，不污染 transcript。降级是兜底（模型可能无视提醒），保证用户永远不会看到"失败"。

**备选**：只调大默认值——治标；`requireCompletionTool`——会额外烧步数（见 Context 表）。

### D7 状态全部挂在 `AgentSession`（connection-scoped）

**决定**：新增 `session.mode` / `session.plan` / `session.pendingQuestion`；不引入新存储、不落盘、不进 rpc。

**为什么**：与 `session-per-connection` 的既定语义一致（刷新 = 新会话 = 状态清零，UI 已在重连时提示"已开始新会话"）。计划 / 提问都是"这一条连接的上下文"，天然属于会话。

### D8 协议不做兼容迂回（明确 breaking）

**决定**：直接新增 `chat.mode` / `chat.plan` / `chat.ask`；`ChatSendMessage` 直接加 `mode` / `planId` / `questionId`；`ToolName` 直接扩三个名字；`AgentRunStatus` 直接加 `'waiting-plan'`。

**为什么**：`agent-server` 与 `chat-client` 同仓配套发布，跨版本混用的唯一后果是"旧客户端看不到卡片"，而客户端本来就必须一起升级（否则新消息被忽略、对话看起来卡住）。不为此设计"文本降级 + 抑制逻辑"能省掉一整套脆弱的双发机制。

## Risks / Trade-offs

- [门禁误伤：模型反复试 `render` 被拦] → `reason` 明确写解锁方式；拦截不消耗额外 LLM 调用；`finish_turn` / `propose_plan` 始终可用。
- [auto 误判：简单任务被判成 plan，多一次确认] → 层 2 用保守规则（只有明确多步信号才判 plan，其余交模型）；UI `ModeSwitch` 一键切 `act`（"直接做"）；`mode.ts` 有回归测试锁死规则。
- [模型不用收尾工具，仍撞上限] → D6 降级兜底（不再 `chat.error`），且 `beforeModel` 提前一步提醒。
- [计划 / 提问状态刷新即丢] → 已有语义（connection-scoped），UI 在重连时已提示"已开始新会话"。
- [`finish_turn` 的输出被当成结果文本重复显示] → `turnEnd.ts` 统一决定"哪些载荷转成 `chat.plan` / `chat.ask`、哪些转成助手文本"；收尾为 plan / ask 时服务端抑制兜底 outputText。
- [token 成本：计划 + 多轮] → 每轮 run 仍受 `MAX_AGENT_STEPS` 限制；计划与进度注入是短段落（非全量历史）；不做自动接力。

## Migration Plan

1. `protocol` 先改（类型是契约），`agent-server` 与 `chat-client` 随后对齐；三者同一个变更内提交。
2. 部署顺序：先发 `protocol` + `chat-client`（宿主升级），再发 `agent-server`；或整体一起发。
3. 回滚：`MAX_AGENT_STEPS` 与 `PLAN_GATE`（`hard` / `off`）都是 env —— 出问题时可只关门禁或调步数，不必回滚代码。

## Open Questions

- 计划的"自动接力"（`AUTO_CONTINUE_MAX_TURNS`）本次只留开关位，是否落地待观察真实使用反馈。
- `mode.ts` 的启发式词表需要随真实语料迭代（当前只覆盖演示项目的中文表达）。
