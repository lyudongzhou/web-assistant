# Agent Session 与页面数据回传设计

> 状态：**已实施**（D1 已定案为方案 B；`expose` 执行面与 `emit` 通知面已落地并通过端到端验收，见 openspec `agent-wc-expose-and-emit`）
> 会话语义**已修订**：由「会话与连接解耦、断线可恢复」改为 **connection-scoped**（一个会话 = 一条 WS 连接，不落任何持久化），见 §3 修订与 openspec `session-per-connection`。
> 影响包：`protocol` / `wc-runtime-core` / `wc-runtime-vue` / `chat-client` / `agent-server` / `demo-app`

## 1. 背景与目标

当前 agent 只能单向推送 `render`：它知道“有哪些页面”（manifest），但**看不到页面里的数据**，
也无法“先做一步、看到结果再做下一步”。

目标场景（验收用例）：

```
用户：“看名字为张三的用户详情”
  → agent 从 manifest 得知：user-detail 需 id；user-list 有 keyword prop 且其 /api/users 数据源含 id
  → 先渲染 user-list（keyword=张三）→ 等页面接口数据回传 → 解析出 id=1
  → 再渲染 user-detail（id=1）
```

为此需要三个新能力：**会话状态**、**双向通信**、**页面数据采集**。

## 2. 已定的四条前提

| # | 决策 | 含义 |
|---|---|---|
| P1 | **agent 有 session** | 会话上下文（当前页面 + 观察快照 + 对话轨迹）随**连接**存活：连接期间持续有效，断开即销毁（见 §3 修订） |
| P2 | **通信用 WebSocket** | 不做“SSE + POST 回执”中间形态；HTTP 仅保留降级/健康检查 |
| P3 | **接受侵入式改老项目** | 在接口层（axios 拦截器 / 自研 http 封装）接一个 EventBus 上报响应数据 |
| P4 | **不做静默页面** | agent 的每一步操作就在渲染区可见地执行，用户能看到全过程 |

## 3. Session 模型

> **修订（`session-per-connection`）**：会话改为 **connection-scoped** —— 一个会话 = 一条 WS 连接。
> 握手时新建、断开即销毁，会话标识与内容都不落任何持久化；多轮对话由连接内的**长驻 agent runtime**
> 承载（`state.messages` 即对话轨迹），每轮的页面上下文用 SDK 的 `prepareTurn` 投影注入。

```ts
interface AgentSession {
  id: string                        // 服务端在 session.ready 下发；客户端**不存不传**（断开即失效）
  createdAt: number
  lastSeenAt: number                // 僵尸兜底回收依据（默认 30min；正常断开由 destroy() 立即回收）
  currentPage?: {                   // 当前页面（agent 与用户都会改变它）
    tag: string
    params: Record<string, unknown>
    title?: string
  }
  recentObservations: PageObservation[]  // 实际实现：page.data / page.emit 的扁平事件流（上限 100 条）
  /**
   * 页面 `defineExpose` 能力清单缓存（tag → key 列表，最近一次覆盖）。
   * chat-client 接到 runtime 的 'page-exposed-changed' 后经 ws `page.exposed` 写入；
   * prompt 构建时取 `pageExposedKeys[currentPage.tag]` 拼「当前页可用方法」。
   */
  pageExposedKeys?: Record<string, string[]>
  activeRun?: AgentRun              // 当前 run（可观测 + 同会话串行判据）
}
```

> 与早期草案的差异：草案里的 `history: ChatTurn[]` 与 `pageContext: Record<tag, …>` 未按此实现 ——
> `history` 只写不读（已删除，多轮改由 runtime transcript 承载）；`pageContext` 落地为扁平的
> `recentObservations`（不按页归并，prompt 里取最近 20 条）。

要点：

- **会话 = 连接**：断线不保留上下文；重连（或刷新）后是**全新会话**，客户端不发任何旧 `sessionId`。
- **断开即止损**：`handleDisconnect` 依次 abort 在跑的 run → 销毁会话（含清理观察等待）→ 注销 RPC → 释放 agent 实例。
- **多连接隔离**：会话态容器全部按 `sessionId` 分区（`connections` / `rpc.sockets` / `waiters` / `sessionAgents`），多标签页各自独立、互不影响。
- **存储抽象**：`SessionStore` 接口保留（内存 `Map` 实现），但**语义是连接期内的存储**，不接任何持久化介质。
- **观察是「免费上下文」**：用户自己操作页面产生的数据也会进来，agent 下一轮直接可用，无需往返。

`PageDataSnapshot`（`page.data` 的载荷）与 `PendingCall`（RPC 挂起项，不持久化）形状如下 ——
两者都不是 `AgentSession` 的字段：观察进入 `recentObservations`，挂起项由 `RpcService` 按 session 管理。

```ts
interface PageDataSnapshot {
  source: string                    // 显式上报的 source 标识
  data: unknown                     // 上报的数据快照（调用方决定裁剪/脱敏）
  truncated: boolean
  at: number
}

interface PendingCall {
  id: string
  name: ToolName
  args: unknown
  createdAt: number
  timeoutMs: number
  resolve: (result: ToolResult) => void
}
```

## 4. WebSocket 协议

统一成 **RPC over WS**：agent 的每个“操作页面”动作 = 一次 `tool.call`，前端执行后回 `tool.result`。
这样 render / 读数据 / 未来的 page action 全走同一个模型。

```ts
// ───────── 客户端 → 服务端 ─────────
type ClientMessage =
  | { t: 'session.hello'; wcBase: string; manifestVersion: number }   // 不带 sessionId：会话 = 连接
  // 一轮的用户输入（含回合边界的"回应"）：
  //   mode     本轮模式请求值（auto / act / plan）；缺省沿用会话模式
  //   planId   确认某个计划（计划卡「开始执行」）
  //   revisePlanId 对某个计划提修改意见（计划卡「修改计划」+「提交修改」）—— 见 §4.7
  //   stepDoneId 人工步骤完成回执（计划卡「我已完成，下一步」，值 = 被推进的 step id）—— 见 §4.8
  //   questionId 回答某个提问（问题卡选项）
  | { t: 'chat.send'; text: string; mode?: AgentMode; planId?: string; revisePlanId?: string; stepDoneId?: string; questionId?: string }
  | { t: 'chat.cancel' }                                          // 用户打断 agent
  | { t: 'tool.result'; id: string; ok: true; data: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: string; timedOut?: boolean }
  | { t: 'page.data'; page?: string; source: string; data: unknown; truncated: boolean; at: number }
                                                                 // 显式上报（调用方 apiBus.report）
  | { t: 'page.emit'; tag: string; event: string; payload?: unknown; at?: number }  // 页面 defineEmits（通知面）
  | { t: 'page.exposed'; tag: string; keys: string[] }             // 页面 defineExpose 的方法名（执行面）
  | { t: 'page.navigated'; tag: string; params: Record<string, unknown>; source: 'page' | 'host' | 'agent' }
  | { t: 'ping' }

// ───────── 服务端 → 客户端 ─────────
type ServerMessage =
  | { t: 'session.ready'; sessionId: string; manifestVersion: number; welcome?: WelcomePayload }
  // 回合边界（见 §4.5）：本轮模式判定 / 计划卡 / 问题卡
  | { t: 'chat.mode'; requested: AgentMode; effective: 'act' | 'plan'
      decidedBy: 'user' | 'heuristic' | 'model'; reason?: string }
  | { t: 'chat.plan'; planId: string; summary: string; steps: PlanStep[]; createdAt: number
      // status 是**服务端权威**的卡片状态（修订会让已批准的计划回到 'proposed'）；
      // revision 首版为 1，每次 revise_plan +1；note 是变更摘要（如「修改 1 步（导出 CSV）」）；
      // steps 里的 PlanStep.status 三态：pending / **waiting-user（轮到你操作，见 §4.8）** / done，
      // 人工步骤还带 owner:'user' / instructions（操作指引）/ issue（上次没做成的原因）——
      // handoff_step 与「我已完成，下一步」都只更新这张卡（planId 不变），客户端无需新增字段
      status: 'proposed' | 'approved'; revision?: number; revisedAt?: number; note?: string }
  | { t: 'chat.ask'; questionId: string; question: string; options: string[]; askedAt: number }
  // 流式文本：channel 区分「结果正文」与「模型思考」（缺省 'text'）
  | { t: 'chat.text'; delta: string; channel?: 'text' | 'reasoning' }
  // 可见执行的轨迹（过程）：phase start 建行、end 就地结算（成败 + 耗时）
  | {
      t: 'agent.step'; index: number; text: string
      phase?: 'start' | 'end'; tool?: ToolName; target?: string; args?: unknown
      ok?: boolean; error?: string; durationMs?: number
    }
  | { t: 'tool.call'; id: string; name: ToolName; args: unknown; timeoutMs: number }
  // 本轮的结束方式（endedBy 见 §4.5）：缺省 = 模型自然结束（或步数用尽被"暂停"）
  | { t: 'chat.done'; steps: number; startedAt?: number; durationMs?: number; endedBy?: TurnEndToolName }
  | { t: 'chat.error'; message: string }
  | { t: 'pong' }

type ToolName = 'render' | 'wait_for_observation' | 'call_page_method'
              | 'propose_plan' | 'revise_plan' | 'handoff_step' | 'ask_user' | 'finish_turn'
                                        // ↑ 后五个是服务端收尾工具（不走 tool.call）；handoff_step 见 §4.8
type TurnEndToolName = 'propose_plan' | 'revise_plan' | 'handoff_step' | 'ask_user' | 'finish_turn'
type AgentMode = 'auto' | 'act' | 'plan'

/**
 * call_page_method 的 args（执行面：agent 调页面 `defineExpose` 暴露的方法）。
 * 见 §4.4 —— 它是 props 控制面之外的第二条「agent → 页面」通道。
 */
interface CallPageMethodToolArgs {
  page?: string      // 不传 = 当前页；传了 = 该容器已渲染的指定 tag
  name: string       // 必须命中 manifest.pages[].exposes[].name，否则 chat-client 拒绝执行
  args?: unknown[]   // 方法实参数组（JSON 可序列化优先）
  timeoutMs?: number
}
```

### 4.1 心跳与重连

- 客户端每 30s 发 `ping`（`heartbeatMs` 可配），服务端回 `pong`
- **重连 = 新会话**：客户端 `session.hello` 不带任何会话标识；服务端每次握手都新建会话并在 `session.ready` 回传新 `sessionId`
- 重连成功（或主动「新会话」）时客户端清空聊天区并提示「连接已重置，已开始新会话」——避免"旧气泡 + 无记忆"的错位观感
- 重连前未完成的 `tool.call` 一律当超时/断线失败（不补发）；连接断开时服务端还会 **abort 正在跑的 run** 并销毁该会话

### 4.2 验收用例的完整时序

```
用户 ──chat.send──▶ agent
                    │ LLM 读 manifest：user-detail 需 id；user-list 有 keyword prop + /api/users 数据源
       ◀─agent.step─┤ "正在用户列表里按『张三』查找…"
       ◀─tool.call──┤ { id:'c1', name:'render',
                    │   args:{ tag:'user-list', props:{ keyword:'张三' }, waitFor:['/api/users'] },
                    │   timeoutMs: 8000 }
runtime.navigate ───┤ 渲染区可见地切到用户列表（keyword 已填入搜索框）
页面 axios 请求 ────┤
页面 / 宿主显式上报 ┤ apiBus.report({ source, data })   ← 只有这一步才会把数据交给 agent
core 侧 ────────────┤ 补 page/at + 体积硬上限（可选 dataSources 裁剪）
       ──tool.result▶ { id:'c1', ok:true,
                        data:{ tag:'user-list', rows:[{id:1,name:'张三',role:'管理员'}], truncated:false } }
                    │ LLM 观察到 id=1
       ◀─agent.step─┤ "找到张三（id=1），打开详情…"
       ◀─tool.call──┤ { id:'c2', name:'render', args:{ tag:'user-detail', params:{ id:1 } } }
       ──tool.result▶ { id:'c2', ok:true, data:{ tag:'user-detail' } }
       ◀─chat.text──┤ "已打开张三的用户详情，可以修改姓名/邮箱/角色。"
       ◀─chat.done──┤
```

### 4.3 失败与兼容语义

| 情况 | 处理 |
|---|---|
| `waitFor` 超时 | **不** reject，而是回 `{ ok:true, data:{ timedOut:true, rows:[] } }` —— 让 LLM 知道“没拿到数据”并自行决定下一步（追问用户 / 换策略），而不是让 ReAct 崩掉 |
| 导航失败（tag 不存在 / bundle 404） | `{ ok:false, error }`，LLM 改口径或报告用户 |
| 未知 `tool.name` | 客户端回 `{ ok:false, error:'unsupported tool' }`（向前兼容：老客户端遇新工具不致崩） |
| `call_page_method` 的 `name` 未命中 expose | 客户端回 `{ ok:false, error:'页面未暴露方法 xxx' }`，LLM 改走 render 或追问 |
| `call_page_method` 执行中抛错 / 超时 | 异常 message 原样回 `ok:false`；超时由 server 侧 `TOOL_CALL_TIMEOUT_MS` 兜底，ReAct 不挂死 |
| 页面尚无 expose（`getPageExposed` 返回 `null`） | prompt 里「当前页可用方法」段缺省，agent 退化为只用 props/dataSources |
| 未知消息 `t` | 两端均忽略并记日志（协议可演进） |
| 单轮步数用尽 | **不再**回 `chat.error`：降级为「已暂停」（正常 `chat.done` + 一句提示，进度保留，回复"继续"接着做）；模型若收到倒数一步提醒并及时 `finish_turn`，则是一轮正常收尾。详见 §4.6 |

### 4.4 执行面（`call_page_method`）与通知面（`page.emit`）

控制面（`props`）只能靠「重新 render 一个页面」间接改页面状态；`call_page_method` 补上第二条
**agent → 页面**通道：直接调页面 `defineExpose` 暴露的方法（筛选 / 刷新 / 提交），返回值经
`tool.result` 回流成 agent 后续推理的事实依据。

**能力清单的两条来源（缺一不可）**：

```
① 构建期（静态）：UserList.vue `defineExpose({ refresh, setKeyword })`
     → analyzer 静态解析 → manifest.pages[].exposes[]（name / signature / description）
     → agent-server 注入 system prompt「可调用方法」段
② 运行期（真实暴露面）：applyNavigation 视图就绪 → core broadcastPageExposed
     → bus 'page-exposed-changed' { tag, keys }（只带方法名，函数不可序列化）
     → chat-client useRuntimeHost → ws `page.exposed` → session.pageExposedKeys[tag]
     → prompt「[当前页 <tag> 可用方法]」段 = 运行时 keys ∪ manifest exposes（keys 优先，
       manifest 提供 signature/description）
```

**一次调用（实测：真实 DeepSeek，demo-app + chat-client）**：

```
用户："不要重新打开页面，直接调用当前页面暴露出来的方法，把用户列表筛选成姓钱的"
                    │ LLM 从 prompt 的「可用方法」里选中 setKeyword
       ◀─agent.step─┤ "调用当前页面的 setKeyword 方法"
       ◀─tool.call──┤ { id:'c7', name:'call_page_method', args:{ name:'setKeyword', args:['钱'] } }
chat-client ────────┤ runtime.getPageExposed(tag) → exposed.setKeyword('钱')
页面 fetch ─────────┤ 表格只剩「钱七」，搜索框同步为「钱」
       ──tool.result▶ { id:'c7', ok:true, data:1 }   // data = 返回值（过滤后条数）
       ◀─chat.text──┤ "已筛选，返回 1 条（钱七）"      // 下一轮直接引用该返回值
```

**通知面（`emit`）**：

```
页面 emit('search', '赵') → Vue CE 派发 CustomEvent（composed:false，停在容器 shadow root 内）
  → 容器按 manifest pages[].events 白名单挂的监听 → runtime 'page-event'
  → WebAssistant emit + ws `page.emit` { tag, event, payload, at }
  → session.recordPageEmit → PageObservation{ type:'page.emit', page, event, payload, emittedAt }
  → prompt 观测段：`[页面事件] search 载荷："赵"（页面：user-list）`
```

要点：

- **函数不跨边界**：expose 的函数引用始终留在浏览器，只上报 key 列表；`args` 走 JSON 序列化。
- **同一入口**：`chat-client` 执行器与验收台 `window.__waRuntime.getPageExposed()` 走的是同一个 runtime API，验收台可不起 agent 直接验证。
- **白名单优先**：容器只挂 `manifest.pages[].events` 声明的事件，避免 `*` 全量监听放大事件量。
- **写入不进执行面**：页面**不要**把会写后端的方法（`save` / `submit` / `delete`）放进 `defineExpose` ——
  `call_page_method` 是 agent → 页面唯一的写通道，不 expose 就是硬边界（agent 硬调只会拿到
  `{ ok:false, error:'方法 xxx 未暴露' }`）。agent 只做「打开 / 预填 / 翻页 / 筛选 / 导航」，提交由用户在
  页面上确认；预填方法统一返回 `{ ui, open, form }` 快照，用户提交后页面自己的 `reportData` 会把结果经
  **观测面**回给 agent（demo-app 全部页面按此约定，见 `packages/demo-app/README.md` §2.1）。
- **MVP 边界**：只能调**已渲染**的 tag；跨页调用需页面实例注册表（未做，见附录 C）。

### 4.5 agent 动作的 ack（in-band，与调用一一对应）

每个 agent 主动动作（activity）的 ack 都以 **in-band** 方式回在 `tool.result` 里 —— 靠 function-calling 的
tool-result 通道与**那次** tool 调用一一对应，模型无需识别 id（带外通知如 `page.emit` 才对不上）。

| 动作 | ack 时机 | `tool.result` |
|---|---|---|
| `render` | 收到即 ack（不等页面/数据就绪） | `{ ok:true, data:{ status:'done', target } }` |
| `call_page_method` · Promise resolve | 等其 resolve | `{ ok:true, data:{ status:'success', target, async:true, value } }` |
| `call_page_method` · 非 Promise | 立即 | `{ ok:true, data:{ status:'success', target, async:false, value? } }` |
| `call_page_method` · reject / 超时 | 等结算 | `{ ok:false, error }` |

- `ActivityStatus = 'done' | 'success' | 'failure'` 与 `ActivityAckData` 定义在 `protocol/websocket.ts`；
  `failure` 由 `tool.result.ok = false` 表达（失败分支无 `data`）。
- **非 Promise 也判成功**：有同步返回值就带在 `value`，无则省略，由 agent 自行判断。
- wc 页面自己 `emit` 的事件**不做归因**（非 agent 发起，只作为决策辅助）。

### 4.6 回合边界：模式 / 计划 / 提问（`add-agent-modes-and-plan-turns`）

**为什么需要**：单轮 ReAct 有步数上限（`MAX_AGENT_STEPS`）。SDK 在打满上限时**抛错**
（`Agent runtime exceeded maxIterations`），过去会被 catch 成 `status: 'failed'` → `chat.error` ——
"查三张数据源并对比"这类任务于是**在第 6 步断在半路**，用户只能自己再打一句"继续"。
根因不是缺计划，而是**一轮 run 被当成了任务的全部**。

两条修正：

1. **收尾工具**（`lifecycle.completesRun`）：`propose_plan` / `revise_plan` / `handoff_step` / `ask_user` / `finish_turn`
   被调用即让本轮 run 以 `completed` 收尾（不是失败）。再加上 `hooks.beforeModel` 在**倒数一步**
   注入收尾提醒、以及把 `exceeded maxIterations` 降级成「已暂停」（`chat.done` + 一句提示），
   用户再也不会看到"步数用尽 = 红色错误"。
2. **回合边界**：计划确认、澄清提问、进度交接三件事共用一套状态机 ——
   本轮以收尾工具结束 → 会话记 `plan` / `pendingQuestion` 并把本轮标成 `waiting-plan` / `waiting-user`
   → 服务端推 `chat.plan` / `chat.ask` → 用户操作经下一次 `chat.send`（带 `planId` / `questionId`）起下一轮。

```
chat.send(mode) ──┬─ act ──► render/call_page_method ──► finish_turn（步数将尽时提醒收尾）
                  │
                  └─ plan ─► propose_plan ──► completed + chat.plan（waiting-plan）
                                   │  ├─「开始执行」→ chat.send(planId) → 门禁放开 → 分轮推进
                                   │  └─「修改计划」→ chat.send(revisePlanId, 修改意见)
                                   │        → revise_plan ──► 同一 planId + revision+1（见 §4.7）
                                   │
                        缺信息？ask_user ──► completed + chat.ask（waiting-user）
                                   │  选项 / 直接打字 → chat.send(questionId) → 下一轮
                                   │
                        这步我做不了？handoff_step ──► completed + chat.plan（waiting-user，见 §4.8）
                                   │  ├─「我已完成，下一步」→ chat.send(planId + stepDoneId) → 先校验再继续
                                   │  └─ 校验没过 → handoff_step(issue) → 同一步回到「需你重做」
```

- **模式**（`AgentMode`）：`act` 直接执行 / `plan` 先出计划 / `auto` 由服务端判定
  （显式 > 启发式 > 模型自判，见 `agent-server/src/agent/mode.ts`）。
  判定结果每轮用 `chat.mode` 下发，UI 显示「当前模式 · 判定来源」。
- **plan 硬门禁**（`PLAN_GATE=hard` 默认）：plan 模式下**未确认计划**时 `render` / `call_page_method`
  被 `hooks.beforeTool` 拦掉（工具不执行，模型收到 `isError` 的 tool-result 并被告知解锁方式）。
  拦截发生在同一轮内，不额外消耗模型调用。
- **状态都在会话上**（connection-scoped）：`session.mode` / `session.plan` / `session.pendingQuestion`，
  刷新/重连即清零（与「会话 = 连接」一致）。
- **客户端**：`PlanCard` / `AskCard` / `ModeSwitch` 三个组件 + `lib/turnState.ts`（纯函数状态机，可单测）。

### 4.7 计划的交互式修订（`add-interactive-plan-revision`）

**改的问题**：以前计划卡上只有一个「重新规划」按钮，宿主发的是**一句固定文案**
（`send('这个计划不太合适，请重新规划')`）。于是 ① 用户没法说"改哪一步"，② 模型只能再 `propose_plan`
→ 新 `planId`、步骤重新编号、旧计划被标 `superseded` → **已完成步骤的进度全丢**。

**现在**：把"改计划"做成一条带输入、带意图、可增量的路径。

```ts
// 1) 用户提交修改意见（计划卡的「修改计划」→ 输入 → 「提交修改」）
{ t: 'chat.send', text: '第 2 步改成导出 CSV，其余不动', revisePlanId: '<当前 planId>' }
//    → 服务端把它记成 session.planTurn（本轮意图）：prompt 据此注入「本轮是计划修改」+ 修改意见
//    → hooks.beforeTool 在本轮**拦掉 propose_plan**（reason 指引改用 revise_plan）
//        —— "不许推倒重来"是服务端保证，不只靠 prompt
// 2) 模型只能调 revise_plan（收尾工具，completesRun）：
revise_plan({ note?, summary?, steps: [{ id?, title, detail?, reopen? }] })
//    steps = **修订后的完整步骤序列**：
//      带 id 且命中当前计划 → 原地改（**保留状态**，done 仍 done；reopen: true 才置回 pending）
//      不带 id            → 新增（分配下一个空闲 step-N，状态 pending）
//      旧计划里没出现      → 删除（移除的已完成步骤会在变更摘要里点名）
//      顺序以 steps 为准   → 顺带支持调整顺序
//    引用不存在的 id / 空 steps / 合并后超过 8 步 → 抛错（模型收到 isError 自行修正）
// 3) 服务端按 id 合并（mergePlanRevision，纯函数）→ **planId 不变**、revision+1、revisedAt
//    → 推 chat.plan（同 planId，带 status/revision/note）+ 一句变更摘要 chat.text
//    → 本轮结束状态 waiting-plan（等用户确认）
```

**两条关键取舍**：

- **修订 ≠ 重新生成**：修订保持 `planId`，卡片在原地更新（`revision` 递增 + `note` 说明改了什么），
  未改动的步骤保住 `step.id` 与完成状态，所以**进度不丢**。「重新生成计划」（弱化链接）仍保留，
  走原来的 `propose_plan` 全量重来 —— 两者在 UI 与协议上都能区分。
- **改完要重新确认**：`session.revisePlan()` 在计划原本已批准时把 `status` 回落成 `proposed` 并
  **清空 `approvedAt`** —— plan 门禁判的就是 `approvedAt`，不清会出现"计划改了、门禁还开着"。
  客户端**只跟随** `chat.plan.status`（不自行推断：修订不改 planId，本地推不出来）。

**客户端**：`PlanCard` 卡内展开输入框（`emit('revise')`）；草稿态与"修改中"在 `lib/turnState.ts`
（`beginPlanRevision` / `updatePlanDraft` / `cancelPlanRevision` / `submitPlanRevision` / `settlePlanRevision`，纯函数可单测）；
`useAgentChat.revisePlan(text, plan)` → `sendWith(text, { revisePlanId })`。
**详情可折叠（与过程区同构的 panel）**：过程区与计划卡是**同一层级的两个 panel**（`过程` 在上、`计划` 在下）——
壳（分隔线 / 底纹 / 折叠头 / 状态行 / 详情 / 动作条）来自共用组件 `PanelSection`，收缩逻辑来自共用的
`usePanelOpen`（`open` + `toggle` + 可选 `resetKey` + 默认值可传 getter）；两处折叠头结构一致
（`panel-head > panel-toggle > chev + title + meta`）、chevron 都在最左、整行可点、**等高**、同款字号层级与悬停反馈。
**折叠粒度也一致：收起 = 只剩折叠头一行** —— 计划 panel 收起时详情（步骤 / 变更摘要 / 说明文案）与动作条
（「开始执行 / 修改计划」，footer 槽）一起收起，只留折叠头里的徽标 / 第 N 版 / 目标摘要 / 步骤计数
（"这是什么计划、做到哪了"）。
**默认折叠值跟随状态**（`usePanelOpen` 的默认值传 getter）：`proposed` 展开（要用户做决定）、
`approved` 收起 —— 点「开始执行」后自动收成一行（与过程区同高）；`resetKey = planId` ⇒
同一份计划（修订）保留折叠偏好，换一份计划（重新生成）回到该计划的默认。
面板详情**限高 + 内部滚动**（壳的 `.panel-body`，`--wa-panel-body-max` 缺省 200px）：计划可以有 8 步，
面板既不能把消息区挤没，也不能被压扁到内容溢出。
修订中的「正在按你的意见更新计划…」放在 `#status` 槽，折叠时也可见（与过程区的「思考中…」同位）。

**验收**（真调模型）：`SMOKE_EXPECT=revise SMOKE_MODE=plan node test/smoke-turns.mjs` ——
要求「同一 `planId` + `revision === 2` + 未改动的步骤 id 保留」，且修订后仍可确认执行。

### 4.8 人工步骤与人机交接（`add-plan-manual-steps`）

**改的问题**：页面上有一部分功能 agent 本来就做不了 —— 写后端的动作（保存 / 提交 / 删除 / 审批）、
不在能力清单里的操作、需要**人本身**才能完成的（扫码 / 验证码 / 短信确认）、以及 `call_page_method`
被拒（权限不足 / 校验失败）。以前这类步骤只有 prompt 规则 8 的一句"必须请用户在页面上确认提交"：

- **计划卡上看不出"现在轮到你了"**（步骤只有 `pending` / `done` 两种标记，提示只飘在对话流里）；
- **没有"交回控制权"的推进口**（`ask_user` 的语义是"问你一个信息"，不是"请你去页面上做件事"）；
- **进度是模型自报的** ⇒ 模型可以把人工步骤直接填进 `finish_turn.done` 然后接着往下走；
- 后续步骤发现用户没做对时，只能含糊说一句 —— 步骤上没有"没做成 / 需重做"这个态。

**现在**：把"这一步得你在页面上手做"做成一条有提示、有按钮、有校验的路径。
**判定权在 agent，判据是页面事实**（不是计划里预先声明，也不是感觉）：

| 判据（规则 16 写进 prompt） | 结论 |
|---|---|
| 动作能在「当前页可用方法」清单里找到（`manifest.exposes` / 运行时 `page.exposed`） | agent 自己 `call_page_method` 做完，**不交接** |
| 写后端的动作（保存 / 提交 / 删除 / 审批）或清单里没有对应方法 | 必须 `handoff_step` 交回用户 |
| 需要人本身才能完成（扫码 / 验证码 / 线下动作） | 同上 |
| `call_page_method` 返回权限不足 / 校验失败 | 不要反复试，改为交接 |

```ts
// 1) 执行到那一步 → 收尾工具 handoff_step（completesRun）
handoff_step({ stepId: 'step-3', instruction: '在订单页填好数量后点「保存」，看到状态变成已提交' })
//    （目标页不是当前页时先 render 过去；计划必须已由用户确认，未确认时调用被拒）
//    带 issue 时是第二种用法：校验发现用户上次没做对 → 请他在页面上重做
//    （**即使用户已经点过「我已完成」、该步已是 done 也允许** —— 这是纠错的唯一通道；
//      不带 issue 去交接一个已完成的步骤会被拒）
handoff_step({ stepId: 'step-3', instruction: '再点一次「保存」',
               issue: { reason: '订单仍是草稿', expected: '状态为已提交' } })
//    → 该步 status='waiting-user' + owner='user' + instructions（+ issue），
//      **其它等待中的步骤收回 pending**（至多一个步骤在等你）
//    → 本轮 endedBy='handoff_step'、run status='waiting-user'
//    → 推 chat.plan（同 planId，该步 waiting-user）+ 一条 chat.text（指引 / 哪里没做成 + 点哪里继续）
//
// 2) 用户在页面上做完 → 点计划卡上的「我已完成，下一步」
{ t: 'chat.send', text: '我已完成第 3 步「保存订单」', planId: '<当前 planId>', stepDoneId: 'step-3' }
//    → 服务端把该步标 done 并清 issue（**只能由这个动作推进**），立刻回推一张权威卡片，
//      并把「用户刚完成这一步」写成本轮意图（session.stepTurn）
//    → 起下一轮：prompt 注入 [用户已完成某个步骤] + 规则 17「先校验再继续」
//
// 3) 校验（读页面数据 / 调页面方法 / 重新打开该页看事实）
//    通过 → 继续后面的步骤（finish_turn 把这一步记进 done）
//    没做成 → 回到第 1 步的 issue 形态：卡片上该步变「需你重做」+ 原因，按钮变「我已重做，下一步」
```

**三条关键取舍**：

- **"不许自己假设用户做完了"是服务端保证**：`applyPlanProgress` 里 `waiting-user` 的步骤不参与
  `finish_turn.done` / `doneAll` 的勾选，计划也不会因此在仍有等待中的步骤时变成 `completed` ——
  光靠 prompt 一定会被"我觉得用户已经做完了"绕过。
- **计划期不预先声明谁做哪一步**：某一步是否需要用户手做取决于**执行到那一步时页面实际能给什么能力**
  （同一个"保存"按钮，有的页面 `expose` 了、有的没有），所以 `owner` 只由运行期 `handoff_step` 写入。
- **客户端只跟随服务端 `steps`**：本地只有 `completingStepId` 这个"刚点完、等校验"的反馈态，
  步骤的 `done` 一律由 `chat.plan` 下发（`waiting-user` 的进出有交接与推进两个来源，本地推断必然漂移）。

**两种"等你"要分清**（都落在 run status `waiting-user`，靠 `endedBy` 与卡片区分）：

| | 触发 | 用户看到的 | 用户怎么继续 |
|---|---|---|---|
| 澄清提问 | `ask_user` | 问题卡（2~5 个选项） | 点选项 / 直接打字（`questionId`） |
| 人工步骤 | `handoff_step` | 计划卡上该步「需要你操作」+ 指引（+「需你重做」+ 原因） | 在页面上做完后点「我已完成 / 我已重做，下一步」（`stepDoneId`） |

**客户端**：计划卡步骤行三态（`describeStepStatus`：done / ⏳ 需要你操作 / ! 需你重做）、
**有步骤在等你时面板强制展开**（提示与按钮不能被折起来藏住，收起态另由「等你操作」徽标与状态行兜底）、
主按钮换成「我已完成，下一步」（带 `issue` 时「我已重做，下一步」）；
状态机在 `lib/turnState.ts`（`handoffStep` / `beginStepCompletion` / `settleStepCompletion`，纯函数可单测）；
`useAgentChat.completeStep(plan, stepId)` → `chat.send({ planId, stepDoneId })`（`handoff` computed 供自写 UI 复用）。
刷新 / 重连即新会话，等待态随之消失（与"会话 = 连接"一致）。

**验收**（真调模型）：`SMOKE_EXPECT=handoff node test/smoke-turns.mjs` —— 任务用"新建数据源并保存"
逼出人工步骤，要求「出现 `waiting-user` + `endedBy === 'handoff_step'` + 用户推进被接受
（该步 `done` 或带回 `issue` 让重做）+ 全程无 `chat.error`」。自动化覆盖见
`agent-server/test/{turnEnd,session.handoff,manifest.service}.test.ts` 与
`chat-client/test/{turnState.test.mjs,render-panel.mjs}`。

## 5. 【待拍板 D1】render 与“等数据”是一个 RPC 还是两个

三种方案均可跑通验收用例，区别在协议形状、LLM 需要的步数、实现复杂度。

### 方案 A：render 自己等（一个 RPC 包完“渲染 + 取数据”）

```ts
// s2c
{ t:'tool.call', id:'c1', name:'render', timeoutMs:8000,
  args:{ tag:'user-list', props:{ keyword:'张三' }, waitFor:['/api/users'] } }
// c2s（等到命中 waitFor 的响应才发）
{ t:'tool.result', id:'c1', ok:true,
  data:{ tag:'user-list', rows:[{id:1,name:'张三'}], truncated:false } }
```

- LLM 工具签名：`go_to_page({ tag, props?, params?, waitFor?: string[] })` → 返回值里就带数据
- **优**：LLM 一步到位（验收用例只需 2 步 ReAct）；token 最省；往返次数最少
- **劣**：`render` 职责不单一（导航 + 等待）；前端要在一个 RPC 内管“导航完成”与“数据到齐”两个异步条件
- **实现**：core 新增 `navigateAndCollect(target, waitFor, timeout)`；内部一个 Promise.race([数据齐, 超时])

### 方案 B：render 立即返回，另一个工具等数据

```ts
{ t:'tool.call', id:'c1', name:'render', args:{ tag:'user-list', props:{ keyword:'张三' } } }
{ t:'tool.result', id:'c1', ok:true, data:{ tag:'user-list' } }          // 立即回
{ t:'tool.call', id:'c2', name:'read_page_data', timeoutMs:8000,
  args:{ tag:'user-list', source:'/api/users', wait:true } }
{ t:'tool.result', id:'c2', ok:true, data:{ rows:[{id:1,name:'张三'}] } }
```

- LLM 工具：`go_to_page({...})` + `read_page_data({ tag, source, wait })`
- **优**：职责单一；`read_page_data` 可单独用于“读已有快照”（`wait:false` 时零往返）；前端实现最直白
- **劣**：验收用例变成 3~4 步 ReAct（每步一次 LLM 调用）→ 延迟与 token 变高；LLM 可能忘了调 `read_page_data`（靠 prompt 约束）
- **实现**：core 新增 `waitForPageData(tag, source, timeout)`；与 navigate 互不耦合

### 方案 C：两种都支持（render 带 waitFor 时等，不带时立即返）

- LLM 工具：同时提供 `waitFor` 参数与独立的 `read_page_data`
- **优**：既能一步到位，也能事后补拉；对 LLM 宽容（忘了带 waitFor 也能补救）
- **劣**：两条路径都要实现与测试；prompt 要说清何时用哪种，否则 LLM 会乱选
- **实现**：= A + B（core 两个方法共用底层的 dataWaiter）

### 对比表

| 维度 | A（合一） | B（分离） | C（都支持） |
|---|---|---|---|
| 验收用例的 LLM 步数 | 2 | 3~4 | 2（带 waitFor） |
| 单轮延迟 | 最低 | 高（多一次 LLM 往返） | 最低 |
| token 消耗 | 最低 | 较高 | 最低 |
| 协议复杂度 | 低 | 低 | 中 |
| core 实现复杂度 | 中（一个方法两个异步条件） | 低 | 高 |
| 职责单一性 | 差 | 好 | 中 |
| “读已有快照”能力 | 靠 pageContext 进 prompt | 工具显式提供 | 两者都有 |
| 失败定位（谁超时） | 略模糊（导航还是数据？需在 result 里区分） | 清晰 | 清晰 |

### 建议（供 review 参考，未定）

从“用户体验与成本”看 **A** 最优；从“工程洁癖”看 **B** 最优。
若选 A，建议在 `tool.result.data` 里区分失败阶段（`{ navigated:true, timedOut:true }`）以弥补它唯一的短板。
若选 C，必须在 system prompt 里给出硬规则（如“需要数据就一定带 waitFor，read_page_data 仅用于读旧快照”）。

## 6. 数据上报：`apiBus`（**显式**调用）

> ### ⚠️ 实现现状（与本文档最初的「透明观察」设想不同）
>
> `NetworkObserver`（包装 `window.fetch` / `XMLHttpRequest` 做**全量**网络观测）**已退役并删除**。
> 原因：在一个已有大量内部接口的真实站点（例如小红书这种宿主页面）上，
> "拦下所有请求"天然会把不相关、甚至敏感的数据带出浏览器；靠事后的白名单 / 脱敏去补救
> 既不可靠（fetch 分支曾漏检黑名单）、也难以维护，且要额外承担改写全局 fetch 的副作用
> （阻塞流式响应、多实例抢占、stop 后残留包装等）。
>
> 现在的规则只有一条：**runtime 不采集任何东西 —— 谁想看，谁在调用点显式上报**。
> 不调 = 零数据出浏览器，天然 fail-closed，也就不需要维护白名单。

`apiBus` 是唯一的数据上报通道。导出位置：

- `@webassistant/wc-runtime-core`（`index.ts` 导出 `apiBus` / `ApiReport`）
- `@webassistant/wc-runtime-vue`（宿主门面转出同一个全局单例）
- **`@webassistant/chat-client`**（也转出 `apiBus`：只装 chat-client 的宿主——用法 A/容器模式——不必为了上报再引一个包）
- 页面内：`useRuntimeServices().reportApiData(payload)`（内部即 `apiBus.report`）

```ts
import { apiBus } from '@webassistant/wc-runtime-vue'

// 在「你愿意公开这份数据」的那个调用点上报一次（宿主 / 页面都可以）
apiBus.report({
  source: 'user-list',   // 来源标识（会出现在 agent prompt 的「来源：」处）
  data: users.map((u) => ({ id: u.id, name: u.name, role: u.role })),  // 字段自己挑
})
```

- **不必**再调 `apiBus.attach()`：runtime 建内核时已经 attach，调用方只负责 `report`。
- **不自动**：没有"axios 拦截器里统一上报"这种做法 —— 想报就报，不报就没有任何数据出浏览器。
- **不做业务脱敏**：runtime 只补 `page` / `at` 并施加体积硬上限（16KB / 深度 4），
  字段选择与脱敏由调用点在调用时决定。

runtime 侧随后只做三件事：

1. 补上当前 `tag` 与 `at`；
2. 若该页 manifest 声明了 `dataSources` 且 URL 命中 → 按 `fields` / `maxRows` / `mask` **额外**裁剪
   （可选加固，**不是**隐私边界）；
3. 以 `page.data` 推送进 session（`wait_for_observation` 用 `source` / `contains` 匹配它）。

```ts
// apiBus 的形状（框架无关，任何 http 封装都能调）
interface ApiReport {
  data: unknown          // 你愿意公开的内容（必填）
  source?: string        // 来源标识；缺省回退到 url
  url?: string           // 原始 URL（可选）：给了才能命中 dataSources 做额外裁剪
  method?: string
  page?: string          // runtime 自动补
}
/* 消费端只有一处：runtime 内核（createKernel 时 attach）。
   业务侧要「把数据交给 agent」永远只调 report() —— 自己调 attach() 会顶掉内核的 sink
   （apiBus 是单 sink，覆盖时会 console.warn 提示）。
   帧内各副本（chat-client / 页面 bundle / 宿主）拿到的是**同一个全局单例**（Symbol.for + globalThis）。 */
interface ApiBus {
  report(payload: ApiReport): boolean                  // true = 有 runtime 在监听；false = 没人听（静默丢弃）
  attach(sink: (payload: ApiReport) => void): () => void   // 仅 runtime 内核使用
  readonly attached: boolean
}
```

> **`apiBus` 的 import 从哪来**：`@webassistant/wc-runtime-vue`（用法 B 宿主本来就有）或
> `@webassistant/chat-client`（用法 A 只装面板时的转出，二者是**同一个全局单例**）。
> 页面内也可用 `useRuntimeServices().reportApiData(payload)`。
>
> **谁该调 `report`**（典型分工）：
> - 页面 / 被服务项目：报**接口数据**（它的调用点才知道拿到什么）；
> - **宿主**：报**宿主才知道的事实**（登录态、角色、宿主上下文、纯前端状态）——
>   页面拿不到这些，宿主不报 agent 就不知道；
> - 两边的共同约束：不调 = 零数据出网；报什么字段 = 调用点自己挑。
>
> `report()` 返回 `false` 意味着**当前没有 assistant 在监听**（例如同一份页面代码跑在没有挂
> `<WebAssistant>` 的 SPA 里）—— 静默丢弃、无副作用，但开发期可以用返回值自检"上报到底有没有生效"。
> 消费端只有 runtime 内核一处（`createKernel` 时 `attach`）；业务侧**不要**自己调 `attach()`
> （单 sink 语义，会顶掉内核，覆盖时会 `console.warn` 提示）。
> 未 attach 就静默丢弃，意味着老项目在**自己的 SPA 里跑**时这行代码无副作用。

## 7. manifest 扩展：`dataSources`

```jsonc
{
  "tag": "user-list",
  "props": [
    { "name": "keyword", "type": "String",
      "description": "按姓名或邮箱过滤；agent 可用它定位某个用户以取得其 id" }
  ],
  "dataSources": [
    { "match": "/api/users",
      "fields": ["id", "name", "email", "role"],
      "mask": ["phone"],
      "maxRows": 20,
      "primaryKey": "id",
      "description": "用户列表数据，含 id —— 需要 userId 时可来这里取" }
  ]
}
```

`dataSources` 是 agent **规划的依据**：它让 LLM 事先知道“进 user-list 能拿到带 id 的用户数据”，
才敢做两步计划。没有它，LLM 只能瞎猜。

**声明位置**：`wc.pages.json` 页面条目的 `dataSources` 字段 ——
analyzer 原样写进 `manifest.pages[].dataSources`（单一来源，不必手改产物）。
命中裁剪只在**上报带 `url` 且 URL 包含 `match`** 时发生；`source` 会变成 `match` 值。


## 8. props 是 agent 的“控制面”（老项目必须让步的一处）

当前 demo 的 `UserList.vue` **没有** keyword prop，搜索词是内部 state，agent 摸不到：

```ts
// 现状（agent 无法驱动）
const keyword = ref('')

// 改成（agent 可驱动，且本身也是更好的组件设计）
const props = defineProps({
  users: { type: Array as PropType<User[]>, default: () => [] },
  // agent 可用它按姓名/邮箱定位用户（会同步到搜索框）
  keyword: { type: String, default: '' },
})
const keyword = ref(props.keyword)
watch(() => props.keyword, (v) => (keyword.value = v))
```

**结论**：`props` = agent 的控制面，`dataSources` = agent 的观测面，`events` = agent 的通知面，
`defineExpose` = agent 的**执行面**（只开放**只读 / 视图操作 / 预填**，见 §4.4）。页面要接受 agent 驱动，
必须把“可被外部决定的输入”显式声明成 props；把“可被外部直接调用的动作”显式 `defineExpose`
（其余三面由 runtime 透明采集，页面零感知）。

## 9. system prompt 的关键规则

```
可用页面（含 props / params / events / dataSources 描述）：……
当前页面：{currentPage}
已知页面数据（摘要）：{pageContext}

规则：
1. 若目标页面所需参数（如 id）用户没直接给出，但另一个页面的 dataSources 声明能提供它：
   先 render 那个页面（用它的 props 过滤缩小范围）并声明 waitFor，
   拿到数据后从中解析出参数，再 render 目标页面。
2. 每一步先用 agent.step 用一句人话说明你在做什么。
3. 若数据超时或未命中，不要猜测 id，改为追问用户或展示列表让用户选。
4. 已在 pageContext 里的数据不要重复拉取。
```

## 10. 可见执行的 UX（P4：不做静默页面）

| 元素 | 设计 |
|---|---|
| 渲染区顶部 | 操作条：`● agent 正在操作 · 步骤 1/2 · 用户列表（keyword=张三）` + 「打断」按钮（发 `chat.cancel`） |
| 对话区 | **过程与结果分区**：结果走气泡（只有答复正文）；`agent.step` / `reasoning` / 错误进「**过程区**」（缺省收起，标题带「N 步 · 进行中 · 失败数 · 本轮耗时」）。过程行不再以 `> …` 拼进结果气泡 —— 那样一根字符串无法在 UI 上分离（已修复） |
| 过程区每行 | 状态点（✓ / ✗ / ◐）+ 工具名 + 文案（**含动作目标**，如「正在打开页面 `<user-list>`」）+ 耗时；失败原因就地显示；点开看 args / result |
| 思考 | 模型的 reasoning 增量走 `chat.text{channel:'reasoning'}`，在过程区渲染成**灰色斜体块**（带「思考」标签），与步骤行刻意不同形；模型无 reasoning 时该块不出现 |
| 步骤闭合 | `agent.step` 带 `phase:'start'|'end'`：end 就地把那一行结算（成败 + 耗时），不新增行 |
| 页面切换 | 不加人为延时 —— 等接口本身就有几百 ms 的自然停留，足够看清 |
| 冲突处理 | agent 操作期间渲染区加半透明遮罩（防误点导致导航冲突），打断后立即解除 |
| 失败 | `timedOut` 时步骤条标红：`未取到用户列表数据，已改为直接询问` |
| 用户中途导航 | 页面自己的 `router.push` 会发 `page.navigated{source:'page'}`，agent 下一轮知道页面变了 |

过程与结果的**数据口径**（什么算过程、什么算结果、怎么与 runtime 活动合并去重）收敛在
`packages/chat-client/src/lib/chatTrace.ts`，两条渲染面（容器面 `ChatPanel` / 宿主直连 `HostAssistantChat`）共用同一份，避免漂移。

## 11. agent-server 结构（Nest + Fastify）

```
agent-server/src/
├── main.ts                        # NestFactory(FastifyAdapter) + ws
├── app.module.ts
├── gateway/
│   ├── agent.gateway.ts           # @WebSocketGateway：socket↔session 绑定、消息路由、心跳
│   └── rpc.service.ts             # ★ pendingCalls：call(name,args,timeout) → Promise<ToolResult>
├── session/
│   ├── session.service.ts         # 取/建/恢复/TTL 清理、history 压缩、pageContext 写入
│   └── session.store.ts           # 接口 + 内存实现（可换 Redis）
├── agent/
│   ├── agent.service.ts           # Cline SDK ReAct 编排、步数上限、cancel
│   └── prompt.service.ts          # manifest + dataSources + currentPage + pageContext → system prompt
├── tools/
│   ├── render.tool.ts             # 走 rpc.call('render', …)（是否带 waitFor 取决于 D1）
│   ├── read-page-data.tool.ts     # 读 session.pageContext（零往返）/ 或等数据（D1=B、C）
│   └── tools.module.ts            # 注册表（zod 校验入参）
├── manifest/manifest.service.ts   # 加载 + 监听变更
└── health.controller.ts           # GET /health
```

工程注意：

- 用 `@nestjs/platform-fastify`；SSE 降级通道若保留，建议裸写 `reply.raw`（避开 `@Sse()` 的 Observable 桥接）
- **agent-server 的 tsconfig 单独放宽**：开 `experimentalDecorators` / `emitDecoratorMetadata`，
  关掉 `verbatimModuleSyntax`（与装饰器元数据冲突）—— 其余包仍用仓库基线
- Cline SDK 是回调式事件流，在 `agent.service` 里直接转成 `gateway.send()`，不引入 RxJS

## 12. 待拍板清单

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| **D1** | render 与等数据是一个还是两个 RPC | A 合一 / B 分离 / C 都支持（第 5 节） | 待定 |
| D2 | sessionId 存储 | `sessionStorage`（一 tab 一会话）/ `localStorage`（跨 tab 共享）/**不存储（会话 = 连接）** | **已定案：不存储**（`session-per-connection`） |
| D3 | history 压缩 | 直接截断最近 N 轮 / LLM 摘要 | **已定案：不用 session.history**；多轮由 runtime transcript 承载，投影按 `MAX_TURN_MESSAGES`（默认 24）截断 |
| D4 | 是否保留 HTTP `POST /chat` | 保留（单步降级）/ 删除 | 保留 |
| D5 | `dataSources` 声明方式 | `wc.pages.json` 手写 / analyzer 从代码推断 | 先手写（推断不可靠） |
| D6 | `chat.cancel` 语义 | 仅停推理 / 并回滚到操作前页面 | 仅停推理（回滚会让用户困惑） |
| D7 | 上报粒度 | 每个响应都上报 / 页面就绪后批量 | 每个响应（简单，已有白名单限流） |
| D8 | 超时/上限数值 | `timeoutMs` 默认 8s、总步数 6、单轮 60s | 先用这组，可配 |
| D9 | mask 在哪侧 | 前端（不出浏览器）/ 服务端 | 前端 |
| D10 | ws 鉴权 | 无（研究阶段）/ 握手带 token | 研究阶段无，接入 ontology 前补 |
| D11 | expose 执行面 / emit 通知面 | 是否纳入本轮 | **已纳入并落地**（`agent-wc-expose-and-emit`） |

## 13. 实施步骤

| 步 | 内容 | 验收 |
|---|---|---|
| 0 | **本文档**（待 review） | 协议表 / session 模型 / 侵入点 / 风险 / 待拍板清单 均成文 |
| 1 | `protocol`：ws 消息联合类型、`dataSources`、`PageDataSnapshot`、`AgentSession` | `pnpm typecheck` 通过；类型即契约 |
| 2 | `agent-server`：Nest + TS 重写（session + gateway + rpc + tools + prompt） | ws 连上、`session.ready`、单步 render 可用；断线重连保上下文 |
| 3 | `wc-runtime-core` / `-vue`：`apiBus`、`reportApiData`、dataSources 摘要、tool.call 执行器 | core 单测覆盖摘要/白名单/mask/超时；vue 侧冒烟 |
| 4 | `chat-client`：SSE → ws、步骤条 + 遮罩 + 打断 | 浏览器实测可见执行轨迹 |
| 5 | `demo-app`：`serve.mjs` 加 `/api/users?name=` mock、拦截器、`keyword` prop、`dataSources` | 「看名字为张三的用户详情」一轮内自动两跳，渲染区可见全过程 |

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| ReAct 挂死 | 每个 `tool.call` 有 `timeoutMs` + 总步数上限 + 单轮总时长上限（D8） |
| token 爆炸 | `apiBus` 上报在 runtime 侧有体积 / 深度硬上限（16KB / 深度 4）+ session 只留最近 100 条观察 + history 压缩 |
| 隐私 | 出网的数据只来自**调用点显式** `apiBus.report`（不调 = 零数据出网）；`dataSources.fields/mask` 是可选的额外加固 |
| 用户中途干预 | 遮罩 + `chat.cancel`；`page.navigated` 让 agent 知道页面被人改了 |
| 断线 | session 存活、`pendingCalls` 判超时；重连 `session.hello` 恢复 |
| manifest 版本漂移 | `session.hello` 带 `manifestVersion`，不一致时提示重建 |
| 老项目不用 axios | `apiBus.report()` 与库无关，任何 http 封装都能调 |
| 页面未声明 keyword prop | agent 无法缩小范围 → 退化为“展示列表让用户选”（prompt 规则 3） |

---

## 附录 A：D1 三种方案的代码级差异

### core 对外 API

```ts
// 方案 A（合一）
interface Runtime {
  navigate(target: NavigationTarget): Promise<NavigationResult>
  /** 新增：导航并等待指定数据源到齐；超时不报错，回 timedOut */
  navigateAndCollect(
    target: NavigationTarget,
    waitFor: string[],
    timeoutMs: number,
  ): Promise<{ navigated: boolean; snapshots: PageDataSnapshot[]; timedOut: boolean }>
}

// 方案 B（分离）
interface Runtime {
  navigate(target: NavigationTarget): Promise<NavigationResult>
  /** 新增：等（或直接读）指定页面的数据 */
  readPageData(options: {
    tag?: string
    source?: string
    wait?: boolean
    timeoutMs?: number
  }): Promise<{ snapshots: PageDataSnapshot[]; timedOut: boolean }>
}

// 方案 C = A + B（共用底层 dataWaiter）
```

### agent 侧工具声明

```ts
// A
go_to_page({ tag, params?, props?, waitFor?: string[] })
//   → { opened, rows?, truncated?, timedOut? }

// B
go_to_page({ tag, params?, props? })            // → { opened }
read_page_data({ tag?, source?, wait?: boolean })// → { rows, truncated, timedOut }

// C
go_to_page({ tag, params?, props?, waitFor? })   // 带 waitFor 就等
read_page_data({ tag?, source?, wait? })         // 仅用于读旧快照
```

### 验收用例的 ReAct 轨迹

```
A（2 步）
  1. go_to_page({ tag:'user-list', props:{keyword:'张三'}, waitFor:['/api/users'] })
     → { opened:'user-list', rows:[{id:1,name:'张三'}] }
  2. go_to_page({ tag:'user-detail', params:{ id:1 } })

B（3 步）
  1. go_to_page({ tag:'user-list', props:{keyword:'张三'} })  → { opened:'user-list' }
  2. read_page_data({ tag:'user-list', source:'/api/users', wait:true })
     → { rows:[{id:1,name:'张三'}] }
  3. go_to_page({ tag:'user-detail', params:{ id:1 } })

C（2 步，与 A 同；但 LLM 忘带 waitFor 时可用第 2 步补救）
```

## 附录 B：与现有实现的衔接点

| 现有能力 | 本设计如何复用 |
|---|---|
| `defineVueContainer({ setup(context) })` 一次性钩子 | `apiBus.attach(context.reportApiData)` 就接在这里 |
| `RuntimeServices`（框架无关约束） | 新增 `reportApiData`；仍然只传纯函数/纯数据 |
| runtime `page-event` 事件 | 直接映射成 ws 的 `page.event` |
| runtime `navigate` 事件（带 `source`） | 直接映射成 ws 的 `page.navigated` |
| core 的 `props.ts` 归一（按 manifest type coerce） | `render` 的 `props`/`params` 照旧走这套 |
| `chat-client` 的 `useAgentChat` | 拆成 `useAgentSocket`（ws）+ 保留消息流式拼接逻辑 |
| 验收台 `wc-demo.html` | 可加一个“模拟 tool.call”按钮，不起 agent 就能测 core 的执行器 |

## 附录 C：不在本轮范围

- ~~`call_page_action`（调页面 `defineExpose` 方法）~~ —— **已实现为 `call_page_method`**（见 §4.4）；遗留边界是「只能调已渲染 tag」，跨页调用需引入页面实例注册表
- agent 直连业务 API（绕过页面取数）—— 与本设计不冲突，可作为另一类工具并存
- 多批次（vue + react）同时在线时的 `dataSources` 命名冲突 —— 待遇到再议；react 批次的 `getPageExposed` adapter 亦未实现
- 持久化（Redis）与多实例部署 —— `SessionStore` 接口已预留
