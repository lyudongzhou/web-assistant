## 1. 协议层（protocol）

- [x] 1.1 `src/session.ts`：`AgentSession` 删除 `history` 与 `socketId`（并更新注释说明会话=连接）
- [x] 1.2 `src/websocket.ts`：`SessionHelloMessage` 删 `sessionId?`；`SessionReadyMessage` 删 `resumed`
- [x] 1.3 `pnpm --filter @webassistant/protocol build` 与 `typecheck` 通过

## 2. agent-server：会话 = 连接

- [x] 2.1 `session.service.ts`：`createOrResume()` → `create()`（只新建）；删除 `addHistory` / `MAX_HISTORY`
- [x] 2.2 `session.service.ts`：新增 `destroy(id)` —— 删 store 条目 + 清理该 session 的 `waiters`（clearTimeout + resolve `failed: session destroyed`）
- [x] 2.3 `session.service.ts`：`cleanupExpired` 注释语义改为「僵尸兜底回收」（TTL 保留）
- [x] 2.4 `gateway/agent.gateway.ts`：`handleHello` 总是 `sessions.create()`；`session.ready` 去掉 `resumed`，不再读取入参 `sessionId`
- [x] 2.5 `gateway/agent.gateway.ts`：`handleDisconnect` 顺序改为 abort → destroy → `rpc.unregister` → `disposeSession`
- [x] 2.6 `gateway/agent.gateway.ts`：`requireSession` 失败只记日志不抛未捕获异常（迟到消息容错）

## 3. agent-server：连接内多轮 + 并发控制

- [x] 3.1 新增 `agent/turnProjection.ts`：纯函数 `projectTurnMessages(messages, maxMessages)`（D8 裁剪 + 工具调用/结果成对保留）
- [x] 3.2 `agent/agent.service.ts`：新增 `Map<sessionId, SessionAgent>`（长驻 `Agent` + `unsubscribe`），`chat.send` 懒建、连接内复用；删除 `activeAgents`
- [x] 3.3 `agent/agent.service.ts`：`systemPrompt` 只放稳定角色/规则；`prepareTurn` 每轮投影 `manifests.buildAgentContext(session)` + 裁剪后的 `messages`
- [x] 3.4 `agent/agent.service.ts`：`render` 工具 `tag` 的 enum 放宽为 `string`，改用 prompt 约束（避免长驻实例的 enum 过期）
- [x] 3.5 `agent/agent.service.ts`：新增 `abortSession(id)` / `disposeSession(id)`；`cancel()` 走同一 abort 路径
- [x] 3.6 `gateway/agent.gateway.ts`：`handleChatSend` 显式拒绝并发（该会话已有 run）→ 回 `chat.error`，不启动第二个 run

## 4. chat-client：去持久化 + 重连即新会话

- [x] 4.1 `lib/agentSocket.ts`：删 `SESSION_ID_KEY` / `loadSessionId` / `saveSessionId` 与 `hello.sessionId`；`connect()` 返回 `{ sessionId }`
- [x] 4.2 `lib/agentSocket.ts`：新增「新会话」通知（`session.ready` 到达且此前已就绪过 → 回调 `onSessionReset`）
- [x] 4.3 `composables/useAgentChat.ts`：新增 `startNewSession()`（清消息 + 触发重连 + 插入系统提示）；`reset()` 保留或改名
- [x] 4.4 `composables/useWebAssistant.ts`：接线 `onSessionReset` → 清空 + 提示；透出 `startNewSession`
- [x] 4.5 内置 UI（`ChatPanel.vue` / `WebAssistant.vue`）：接入「新会话」入口（若现有布局无合适位置则跳过并记录）

## 5. 测试与验证

- [x] 5.1 `test/session.service.test.ts`：`createOrResume()` 改 `create()`；新增 `destroy()` 立即结束观察等待的用例
- [x] 5.2 新增 `test/turnProjection.test.ts`：裁剪预算、工具对成对保留、systemPrompt 不受裁剪影响
- [x] 5.3 新增 `packages/chat-client/test/agentSocket.test.mjs`：不写 `sessionStorage`/`localStorage`、`session.hello` 无 `sessionId`、重连触发 `onSessionReset`
- [x] 5.4 `pnpm typecheck` + `pnpm test` 全绿（protocol / chat-client / agent-server）

## 6. 文档与发布

- [x] 6.1 `docs/agent-session.md`：反转 P1 前提、协议表删字段、§4.1 重连语义、D2 决策行
- [x] 6.2 `PROJECT.md`：§6.7 / §9 session 段更新为 connection-scoped
- [x] 6.3 `TODO.md`：sessionStorage 条目改写为已完成语义
- [x] 6.4 `.changeset/*.md`：`@webassistant/protocol` minor（含 BREAKING 说明）+ `@webassistant/chat-client` minor
- [x] 6.5 openspec `record_revision`：记录「协议契约变更：session 由 connection-decoupled 反转为 connection-scoped」
