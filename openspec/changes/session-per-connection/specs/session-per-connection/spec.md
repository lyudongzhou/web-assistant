## ADDED Requirements

### Requirement: 会话随 WS 连接创建与销毁

系统 MUST 让一个 agent 会话的生命周期严格等于一条 WebSocket 连接：连接建立（`session.hello`）时创建新会话，连接断开时销毁该会话及其全部上下文，且 MUST NOT 复用客户端提供的任何会话标识。

#### Scenario: 握手即新建会话

- **WHEN** 客户端建立 WS 连接并发送 `session.hello`（载荷只含 `wcBase` / `manifestVersion`）
- **THEN** 服务端创建新的 `AgentSession` 并在 `session.ready` 中回传其 `sessionId`，响应中不含 `resumed`

#### Scenario: 断开即销毁会话

- **WHEN** 该 WS 连接关闭
- **THEN** 服务端立刻从 session store 删除该会话（含 `currentPage` / `recentObservations` / `pageExposedKeys`），并释放该会话的长驻 agent 实例

#### Scenario: 浏览器刷新得到全新会话

- **WHEN** 用户刷新页面（WS 断开后重新建立连接）
- **THEN** 新连接的 `session.ready` 返回与刷新前不同的 `sessionId`，且该会话不含刷新前的任何页面上下文与对话内容

### Requirement: 会话信息零持久化

系统 MUST NOT 在任何持久化介质（浏览器 `localStorage` / 客户端 `sessionStorage`、服务端磁盘或数据库）中保存会话标识或会话内容；进程内存中的会话只在连接期间存活。

#### Scenario: 客户端不写入会话标识

- **WHEN** 客户端建立连接、收到 `session.ready`、断线并重连
- **THEN** `sessionStorage` 与 `localStorage` 中均不出现会话标识写入，重连后也不向服务端发送任何旧会话标识

#### Scenario: 服务端不落盘

- **WHEN** 服务端处理握手、对话、导航与观察
- **THEN** 会话状态只存在于进程内存（`SessionStore` 的内存实现），不产生磁盘/数据库写入

### Requirement: 多条连接并存且互相隔离

系统 MUST 支持任意多条 WS 连接同时存在，每条连接各自持有独立会话；任一会话的页面上下文、观察流、对话内容与运行状态 MUST NOT 影响其它会话。

#### Scenario: 并行对话互不干扰

- **WHEN** 两条连接同时各自 `chat.send`，并在各自连接内 `page.navigated` 到不同页面
- **THEN** 两条连接各自维护自己的 `currentPage` / `recentObservations` / 对话上下文，prompt 投影与回复互不串台

#### Scenario: 一侧断开不影响另一侧

- **WHEN** 连接 A 断开（触发会话销毁与 run abort）
- **THEN** 连接 B 的会话、对话与页面上下文保持有效，仍可继续 `chat.send` 并得到回复

### Requirement: 断线时中止运行中的 run 并释放资源

连接断开时，系统 MUST 立刻中止该会话正在运行的 agent run，并释放该会话占用的资源（观察等待、RPC 挂起调用、agent 实例），MUST NOT 继续向已断开的连接推送消息。

#### Scenario: 断线中止运行中的 run

- **WHEN** 某会话的 agent run 正在流式输出（连接处于打开状态），该连接断开
- **THEN** 服务端 abort 该 run，之后不再向任何连接推送该 run 的 `chat.text` / `agent.step`

#### Scenario: 断线清理观察等待

- **WHEN** 会话中存在等待中的观察（`wait_for_observation` 未完成），连接断开
- **THEN** 该等待立即以失败结束（不占用计时器、不等待超时时间），其计时器被清理

#### Scenario: 断线后迟到消息被拒绝

- **WHEN** 连接断开后，服务端收到属于该已销毁会话的迟到消息（如 `tool.result`）
- **THEN** 服务端不抛未捕获异常，只记录日志并忽略该消息

### Requirement: 僵尸会话兜底回收

系统 MUST 保留 TTL 清理作为异常路径（如未触发断开处理）的兜底回收，其语义为「回收」而非「保活」。

#### Scenario: 未正常断开的会话被回收

- **WHEN** 某会话在超过 `SESSION_TTL_MS` 内没有任何活动，且其连接未触发正常断开处理
- **THEN** 定期清理任务将其从 session store 移除
