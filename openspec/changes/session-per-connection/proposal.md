# session-per-connection

## Why

现在的 session 语义是「**会话与连接解耦**」：`sessionId` 存在浏览器 `sessionStorage`（`chat-client/src/lib/agentSocket.ts`），刷新/重连时带上它，服务端 `createOrResume()` 命中内存 Map 后 `resumed: true` 恢复上下文，TTL 30min。

这套语义带来三个实际问题：

1. **刷新后前后端状态发岔**：客户端渲染宿主默认 `initialPage: false` → 回到欢迎页、且不发 `page.navigated`；服务端却仍保留刷新前的 `currentPage` / `recentObservations` / `pageExposedKeys`，下一轮 prompt 会告诉模型「当前页是 `<user-list>`，可调用 `nextPage()`」——与实际渲染完全不符。
2. **刷新后旧 run 继续串流、且可并发起第二轮**：`activeAgents` 按 `sessionId` 保活，`rpc.register` 是覆盖式的 → 旧 run 的 `chat.text` 继续推到刷新后的新页面；此时用户再发消息，同一 sessionId 会跑起**两个并发 Agent**，且旧实例的引用被覆盖后**再也 cancel 不掉**。
3. **"多轮对话"其实不存在**：`session.history` 只写不读（`buildAgentContext` 不读、`new Agent()` 也不传 `initialMessages`），每轮 run 都是单轮无记忆对话。于是"保持 session"只保住了陈旧页面上下文，没保住对话本身 —— 用户看到的现象（刷新后还是老会话）与体验预期（新会话）相反，收益却是负的。

结论：**会话应当是连接作用域的** —— 连接建立即新会话，连接断开即销毁，会话信息不落任何持久化；多轮对话在连接内由长驻 agent runtime 真正承载。

## What Changes

- **BREAKING** `protocol`：`SessionHelloMessage` 删除 `sessionId?`；`SessionReadyMessage` 删除 `resumed`。会话 id 由服务端在 `session.hello` 时生成并回传，客户端**不持久化、不复用**。
- **BREAKING** `protocol`：`AgentSession` 删除 `history`（只写不读的死数据）与 `socketId`（连接作用域后不再需要绑定/解绑判定）。
- **agent-server：会话 = 连接**
  - `SessionService.createOrResume()` → `create()`（只新建）；新增 `destroy(session)`，同时清理该 session 挂在 `waiters` 上的观察等待计时器（现在断线后只能干等超时）。
  - `AgentGateway.handleDisconnect`：**先 abort 运行中的 run** → `sessions.destroy()` → `rpc.unregister()` → 释放该 session 的长驻 agent 实例。
  - 保留 `SESSION_TTL_MS` + 定期清理作为僵尸兜底（socket 未正常触发 disconnect 时）。
- **agent-server：连接内真多轮 + 多连接隔离**
  - 新增 `AgentService` 的 `Map<sessionId, SessionAgent>`：`chat.send` 时**懒建一个长驻 `AgentRuntime` 实例**并在其生命周期内复用 → runtime 自身的 `state.messages` 累积多轮上下文（含 tool-call / tool-result），SDK 内建的 "already running" 保护自动生效。
  - 动态上下文（manifest 页面清单 + 通用/项目规则 + 当前页可用方法 + 最近观察）改用 SDK 的 **`prepareTurn`** 每轮投影（只影响当次 provider 请求，不回写 transcript）→ manifest 热重载 / 切页 / 新观察每轮自动最新，且不需要重建实例。
  - `handleChatSend` 增加「本会话已有 run 在跑」的显式拒绝，回 `chat.error`（不再依赖 SDK 抛错兜底）。
  - 所有会话态容器都按 `sessionId` 分区（`connections` / `rpc.sockets` / `waiters` / `sessionAgents`），**多条 WS 连接并存时彼此完全隔离**。
- **chat-client：去掉一切会话持久化**
  - `agentSocket.ts` 删除 `SESSION_ID_KEY` / `loadSessionId` / `saveSessionId` 与 `session.hello` 的 `sessionId` 字段；`connect()` 返回值去掉 `resumed`。
  - 掉线自动重连保留，但语义变为「**重连 = 新会话**」；重连成功后清空聊天记录并提示「连接已重置，已开始新会话」（避免"旧消息 + 无记忆"的错位观感）。
  - `useAgentChat.reset()` 升级为"开始新会话"入口（清消息 + 重连），并接到内置 UI 上（当前 `reset` 未接线）。

## Capabilities

### New Capabilities

- `session-per-connection`: 会话生命周期与 WS 连接严格绑定 —— 握手即新建、断开即销毁、不落任何持久化；多连接并存各自独立；断线时终止在跑的 run 并释放其资源（观察等待 / RPC 挂起 / agent 实例）。
- `agent-multi-turn`: 单个连接内的多轮对话 —— 同一连接复用长驻 agent runtime 累积对话上下文，并用每轮投影注入最新页面上下文（manifest / 当前页方法 / 最近观察），且同一会话禁止并发 run。

### Modified Capabilities

（无既有 spec 变更：`openspec/specs/` 尚无 spec，本变更只新增能力。）

## Impact

- `packages/protocol`：`src/websocket.ts`（`SessionHelloMessage` / `SessionReadyMessage`）、`src/session.ts`（`AgentSession`）、CHANGELOG/changeset（minor，含 breaking 说明）。
- `packages/agent-server`：`session/session.service.ts`（create/destroy/删 history）、`session/session.store.ts`（接口不变）、`gateway/agent.gateway.ts`（hello / chat.send / disconnect）、`agent/agent.service.ts`（长驻实例 + `prepareTurn` + `disposeSession`）、`manifest/manifest.service.ts`（`buildAgentContext` 作为投影函数被复用，签名可能微调）。
- `packages/chat-client`：`lib/agentSocket.ts`（去持久化）、`composables/useWebAssistant.ts`（重连=新会话的清理与提示）、`composables/useAgentChat.ts`（`reset` → 新会话语义）、`components/ChatPanel.vue`（新会话入口，可选）。
- 测试：`packages/agent-server/test/session.service.test.ts`（`createOrResume` → `create`、新增 `destroy` 清 waiter）、新增投影纯函数单测、`packages/chat-client/test/agentSocket.test.mjs`（不再读写 storage / 重连即新会话）。
- 文档：`docs/agent-session.md`（P1 前提反转、协议表、§4.1 重连语义、D2 决策）、`PROJECT.md`（§6.7 / §9 session 段）、`TODO.md`（sessionStorage 条目改写）、README（如涉及）。
- 发布：`.changeset` 记录 `protocol` / `chat-client` 变更；`agent-server` 为 private 包无需版本。
