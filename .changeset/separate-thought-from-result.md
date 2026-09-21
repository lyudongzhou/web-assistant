---
'@webassistant/protocol': minor
'@webassistant/chat-client': minor
---

过程与结果分离：思考走独立通道、过程步骤带起止与耗时

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
