## ADDED Requirements

### Requirement: 提问工具与选项约束

系统 MUST 提供 `ask_user({ question, options[] })` 工具：`question` 非空，`options` MUST 为 2~5 个非空字符串。调用 MUST 使本轮 run 以 `completed` 正常收尾，并把问题结构化下发（`chat.ask`）。

#### Scenario: 提问后本轮正常结束

- **WHEN** 模型调用 `ask_user({ question: '要看哪个用户？', options: ['张三', '李四'] })`
- **THEN** 本轮 run 状态为 `completed`，服务端下发 `chat.ask`（含 `questionId`、`question`、`options`），且会话进入等回答状态

#### Scenario: 选项数量非法时被拒绝

- **WHEN** 模型以 1 个或 6 个选项调用 `ask_user`
- **THEN** 该调用被判为非法输入（工具结果 `isError`），本轮不进入等回答状态

#### Scenario: 一次只问一个问题

- **WHEN** 同一轮内模型连续调用两次 `ask_user`
- **THEN** 只有最后一个问题生效并下发（会话中只保留一个待回答问题）

### Requirement: 待回答状态与回答关联

会话 MUST 记录待回答问题（`session.pendingQuestion`），并 MUST 在收到携带对应 `questionId` 的 `chat.send` 时把该问题标记为已回答（记录回答内容与时间）。

#### Scenario: 用户以选项回答

- **WHEN** 待回答状态下客户端发送 `chat.send({ text: '张三', questionId: '<当前问题 id>' })`
- **THEN** 该问题被标记已回答（`answeredAt` 与 `answer` 被记录），且该文本作为本轮输入进入模型上下文

#### Scenario: 用户以自由文本回答

- **WHEN** 待回答状态下客户端发送不带 `questionId` 的 `chat.send`
- **THEN** 待回答问题被视为已由该文本回答（不要求客户端必须回填 id），并进入本轮上下文

#### Scenario: 回答后不重复提问同一问题

- **WHEN** 某问题已回答，模型在同一连接后续轮次再次请求同一信息
- **THEN** 会话中不保留该问题的待回答标记（回答内容作为上下文可被模型引用）

### Requirement: 提问回合不阻塞 run

提问 MUST NOT 让 run 处于挂起等待用户的状态：run 在提问工具返回时即结束，用户回答通过下一次 `chat.send` 起新一轮。

#### Scenario: 提问后输入框可用

- **WHEN** `chat.ask` 已下发
- **THEN** 会话没有正在执行的 run（`isRunning` 为假），用户可直接回答或被允许发送新指令

#### Scenario: 回答可被取消

- **WHEN** 待回答状态下用户点击「新会话」或断线重连
- **THEN** 待回答问题随会话销毁，不再被后续轮次引用
