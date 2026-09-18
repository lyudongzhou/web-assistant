## Context

当前架构（`docs/agent-session.md` 的 P1 前提）明确要求「**session 与连接解耦**」：`sessionId` 存 `sessionStorage`（一 tab 一会话），断线/刷新后带 `sessionId` 重连，服务端 `SessionService.createOrResume()` 命中内存 `Map` 即 `resumed: true`，TTL 30min。

实际运行暴露了三个与设计预期相反的结果（代码证据）：

| # | 现象 | 证据 |
|---|---|---|
| 1 | 刷新后前端回欢迎页、服务端仍记旧页面 | `chat-client/src/lib/initialPage.ts`（缺省 `null` → 不导航）+ `useRuntimeHost.ts:171-181`；只有 `navigate` 事件才触发 `sendPageNavigated`（`useWebAssistant.ts:183-193`）→ 服务端 `currentPage` 保持陈旧值，并被 `buildAgentContext` 注入 prompt（`manifest.service.ts:202-236`） |
| 2 | 刷新后旧 run 继续串流、可并发第二个 run、旧实例 cancel 不掉 | `agent.service.ts:38`（`activeAgents` 按 sessionId 保活）、`rpc.service.ts:34-37`（`register` 覆盖同一 sessionId 的 socket，而 :56-58 的 `unregister` 有身份校验 → 新注册不被误删）、`agent.gateway.ts:115-131`（`chat.send` 无 in-flight 检查）、`agent.service.ts:149`（`activeAgents.set` 覆盖引用） |
| 3 | "多轮对话"不存在 | `session.history` 只写不读（`session.service.ts:114-120` 写；`buildAgentContext` 入参只 pick `currentPage / pageExposedKeys / recentObservations`，`manifest.service.ts:138`）；`new Agent()` 也没传 `initialMessages`（`agent.service.ts:138-147`） |

同时确认了 SDK（`@cline/sdk` → `@cline/agents@0.0.77`）的两个事实，它们决定了本设计的可行性：

```js
// AgentRuntime.execute()
if (this.state.status === "running") throw Error("Agent runtime is already running");  // 内建并发保护
for (let a of e ? Rv(e) : []) this.state.messages.push(a);   // 只 append，不重置 → 实例级多轮累积

// AgentRuntime.prepareTurnForModelRequest()
const r = await this.config.prepareTurn({ ..., messages, systemPrompt, tools, model, ... });
if (r.messages)     t = { ...t, messages: F(r.messages) };        // 仅影响当次 provider 请求
if (r.systemPrompt !== undefined) t = { ...t, systemPrompt: r.systemPrompt };
```

即：**长驻实例天然多轮**，**`prepareTurn` 是"每轮投影最新上下文"的官方入口**（且不污染 canonical transcript）。

## Goals / Non-Goals

**Goals:**

- 会话作用域严格等于 WS 连接：握手新建、断开销毁、零持久化（浏览器与磁盘均不留会话信息）。
- 单连接内真正的多轮对话（含 tool-call / tool-result 在内的完整 transcript 由 runtime 承载）。
- 每轮 prompt 反映**最新**的页面上下文（当前页可用方法 / 最近观察 / manifest 变更）。
- 多连接并存时**完全隔离**（会话态容器全部按 sessionId 分区，无全局单例）。
- 断线时立刻止损：abort 在跑 run、清理观察等待、释放 agent 实例。

**Non-Goals:**

- 不做会话持久化 / 恢复 / 跨标签页共享 / Redis 落库（`SessionStore` 抽象保留，但不接持久化实现）。
- 不做历史回放协议（刷新 = 新会话，无需回放）。
- 不改 `render` / `wait_for_observation` / `call_page_method` 三个工具的行为语义。
- 不引入多 agent 编排、不引入审批流。

## Decisions

### D1：会话作用域 = 连接（反转原 P1）

**选择**：`session.hello` 每次生成全新 `AgentSession`；socket 断开即销毁。
**理由**：原设计想要的收益（断线不丢上下文）依赖"前后端状态严格对齐"，而客户端渲染面（`initialPage` 默认不导航）与服务端 `currentPage` 在刷新后必然发岔，收益为负；同时它引入了 #2 的并发/串流问题。
**放弃的替代**：
- A1 保留恢复但刷新时显式清上下文（客户端发"无页面"信号）→ 仍需处理陈旧 `currentPage`、`waitForObservation` 命中旧观察、多标签隔离等一堆补丁；性价比低。
- A2 让前端记住 tag 并在刷新后恢复页面（UI 与后台对齐）→ 与"刷新即新会话"的用户心智不符，且刷新仍会丢聊天记录，观感更怪。

### D2：多轮骨架 = 连接内长驻 `AgentRuntime` 实例 + `prepareTurn` 投影

**选择**：`AgentService` 维护 `Map<sessionId, { agent, unsubscribe }>`，`chat.send` 时懒建、连接内复用；动态上下文每轮由 `prepareTurn` 注入。
**理由**：
1. 多轮零成本：`state.messages` 是实例级且 `execute()` 只 append（源码见 Context），tool-call/tool-result 天然在同一份 transcript 里。
2. 并发保护内建：SDK 主动抛 `Agent runtime is already running`，不用自己维护状态机。
3. `prepareTurn` 是官方投影入口：返回的 `systemPrompt` 覆盖当次请求、`messages` 可替换当次请求（不回写 transcript），正合"动态上下文每轮最新、但不要每条都写进历史"。
**放弃的替代**：
- B1 每轮 `new Agent()` + `initialMessages` 回灌：需要自己序列化/裁剪 transcript，且回灌的 assistant/tool-result 消息与当轮 `tools` 声明不一致时易被 provider 拒；systemPrompt 每轮重建（这点是优点）但可由 `prepareTurn` 等价获得。
- B2 每轮 `new Agent()` 但把历史拼进 systemPrompt 文本：语义上模型看到的"历史"不是消息序列，工具调用轨迹会丢，且 token 浪费。

### D3：动态上下文（manifest / 当前页 / 观察）走 `prepareTurn`，不进 `systemPrompt`

**选择**：`new Agent({ systemPrompt: <稳定角色+规则> })` 只放稳定内容；`prepareTurn: () => ({ systemPrompt: this.manifests.buildAgentContext(session) })` 每轮注入完整上下文。
**理由**：`buildAgentContext()` 已把"manifest 页面清单 + 通用规则 + 项目规则 + 当前页可用方法 + 最近观察"拼成完整 prompt（`manifest.service.ts:138-238`），直接复用为投影结果即可；manifest 热重载（本地 mtime / 远程定时刷新）与新观察**下一轮自动生效**，无需重建实例。
**影响**：`AgentService.run()` 的闭包需长期持有 `session` 引用（而不是每轮从 `sessions.find()` 拿）。

### D4：断线处理顺序：abort → destroy → unregister → dispose

**选择**：`handleDisconnect()` 依次 `agents.abortSession(id)` → `sessions.destroy(id)`（含清 `waiters`）→ `rpc.unregister(id, socket)` → `agents.disposeSession(id)`。
**理由**：先 abort 让 run 立刻进入中止路径（`throwIfAborted`）；destroy 立刻删除会话与观察等待，避免"断线后 waiter 干等超时"；`disposeSession` 释放 runtime 与事件订阅。
**副作用**：abort 后 run 的收尾 `rpc.notify()` 会因 socket 已注销而失败 —— 已有行为（`rpc.service.ts:39-54` 只 warn），无需额外处理。

### D5：协议删字段（BREAKING）+ 宽进严出

**选择**：删 `SessionHelloMessage.sessionId?`、`SessionReadyMessage.resumed`、`AgentSession.history`、`AgentSession.socketId`。
**兼容性**：服务端**不读取**入参 `sessionId`（旧客户端多发一个字段 = 被忽略）；`resumed` 缺失时新客户端本来就不读 → 收发两侧都是"宽进严出"，可滚动部署。
**理由**：留字段会被误用（有人会以为还能恢复）；删掉才是"契约即文档"。

### D6：重连 = 新会话，前端清空 + 提示

**选择**：保留 `autoReconnect`（网络抖动自动重连），但收到新的 `session.ready` 时若此前已有消息，则清空 `messages` 并插入系统提示「连接已重置，已开始新会话」；`useAgentChat` 暴露"开始新会话"动作（清消息 + 主动重连）并接到 UI。
**理由**：不清消息会出现"旧气泡 + 新会话（无记忆）"的错位；主动入口让用户不必关标签页。

### D7：多连接隔离（验收项）

**选择**：所有会话态容器按 `sessionId` 分区：`gateway.connections: Map<socket, {id, session}>`、`rpc.sockets: Map<sessionId, socket>`、`session.waiters: Map<waitId, {sessionId,...}>`、`agents: Map<sessionId, SessionAgent>`；禁止引入跨会话共享的单例状态。
**验证**：单测 + 手工双标签页并行对话，断言两边 `sessionId`、当前页、观察、对话互不影响，且断开一侧不影响另一侧。

### D8：上下文有界裁剪

**选择**：`prepareTurn` 里对投影做预算裁剪：`messages` 超过 `MAX_TURN_MESSAGES`（默认 24，env 可调）时只保留**最近 N 条**，并保证工具调用/结果成对不被拦腰截断；systemPrompt 恒定注入（规则永不丢）。
**理由**：长对话会让每轮 token 线性增长；SDK 的 overflow recovery 只在 provider 拒答时兜底，不够；显式裁剪可控且可观测。
**注意**：裁剪只作用于投影，不修改 runtime 的 canonical transcript（保留完整轨迹便于调试/日志）。

### D9：保留 TTL 清理作为僵尸兜底

**选择**：保留 `SESSION_TTL_MS` + 60s 定期清理，但语义从"保活窗口"变为"未正常 disconnect 时的兜底回收"。
**理由**：进程崩溃/半开连接等异常路径下 `handleDisconnect` 可能不触发；兜底成本极低。

## Risks / Trade-offs

- [runtime transcript 无限增长 → token 成本与延迟上升] → D8 投影裁剪；另用 `MAX_AGENT_STEPS` 限制单轮迭代（沿用现状）。
- [`prepareTurn` 回传 `messages` 会干扰 SDK 的 overflow 恢复] → SDK 要求「返回的 messages 严格短于原消息」，否则抛错而非走恢复；实现只在**真的裁掉了**才回传 `messages`（`projected.length < context.messages.length`），未裁剪时只投影 `systemPrompt`。
- [长驻实例让 `render` 工具的 `tag` enum 变成实例级快照] → manifest 新增页面后 enum 会过期；缓解：把 `render.tag` 的 enum 放宽为 `string` + prompt 约束「只能用清单里的 tag」（`agent.service.ts:70`）。
- [abort 时机竞争：abort 与 destroy 之间 run 可能刚好完成并 notify] → notify 失败仅 warn；迟到 `tool.result` 因 `rpc.unregister` 已被拒绝，且 `requireSession` 抛错需被 Nest 捕获（仅记日志），落地时需实测确认不崩。
- [单实例串行导致"上一条没答完不能发下一条"] → 前端已有 `loading` 互斥，后端再显式拒绝并回 `chat.error`；这是有意行为，不再允许并发。
- [删协议字段是 BREAKING] → D5 的宽进严出 + changeset 明确标注；仓内 grep 已确认只有 `agentSocket.ts` 消费这两个字段。
- [前端清空消息可能被误判为 bug] → 明确文案提示 + CHANGELOG/文档说明"重连即新会话"。

## Migration Plan

1. 一次性提交协议 + 服务端 + 客户端（monorepo 同仓）：`protocol` minor（含 BREAKING 说明）、`chat-client` minor；`agent-server` 为 private 包无版本。
2. 滚动部署兼容：服务端忽略入参 `sessionId`（旧客户端无感，只是每次连新会话）；新客户端不读 `resumed`（旧服务端无感）→ **无需**双版本并行。
3. 回滚：协议字段回滚需重发 `protocol`/`chat-client`；服务端回滚只需还原 `gateway`/`session.service`/`agent.service` 三个文件（无数据迁移、无状态残留）。
4. 手工验收：① 同连接多轮追问（"看张三详情" → "他的电话是多少"）；② 刷新 → 新 `sessionId`、旧上下文不出现；③ 刷新时旧 run 立即停止（不再往新页面串流）；④ 双标签页并行对话互不干扰；⑤ 杀掉服务端 → 客户端重连 → 清空并提示新会话。

## Open Questions

- Q1（可后置）：D8 的裁剪是否升级为"早期对话摘要"（LLM 压缩）？当前先做截断。
- Q2（可后置）：是否在 UI 上显示 `sessionId`（排障用）？当前只进 debug 日志与调试钩子。
