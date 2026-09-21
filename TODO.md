# WebAssistant Agent 改造 TODO

> 目标：业务页面无需实现 Agent 专用协议；Agent 根据 manifest 的页面能力规划操作，Runtime 透明观察页面事实，并通过 timeout 防止任务永久卡住。
>
> 传输约束：项目是全新项目，**WebSocket 为唯一 Agent 通信链路**，不规划旧版本或其他传输方式兼容。

## 0. 设计约束

- [x] 业务页面不感知 Agent/WebSocket 协议；**数据上报由宿主侧代码显式调用** `apiBus.report()`。
- [ ] 页面继续按自身逻辑请求接口、渲染数据和处理交互。
- [ ] manifest 只描述页面能力和输入约束：`description`、`props`、`params`、可选事件。
- [ ] `dataSources` 不作为页面必须实现的反馈协议；如保留，只做可选观察/安全策略。
- [ ] 不要求 `page.ready` 或页面加载完成事件。
- [ ] `render` 只发起导航并立即返回 accepted，不等待页面或接口完成。
- [x] **Runtime 不做透明观察**（不拦 fetch/XHR）：不调 `apiBus.report` 就没有任何数据出浏览器；
      自动网络观测（`NetworkObserver` / `page.network.*`）已退役删除。
- [ ] Agent 等待证据，不等待 page ready；上报的数据里出现错误信息时立即结束等待。
- [ ] 页面无上报、组件直接报错或无有效观察结果时，用 observation timeout 托底。
- [ ] timeout、error、空结果不能让 Agent 猜测业务数据。
- [ ] 超时后的晚到响应可写入 Session，但不能自动重启已结束的 AgentRun。
- [ ] 所有 AgentRun、Tool RPC、观察等待和网络请求都必须有边界和清理逻辑。

## 1. 协议与设计文档

目标文件：`/Users/lvdongzhou/codePersonal/webassistant/docs/agent-session.md`

- [ ] 将 WebSocket 定义为唯一通信链路，移除其他传输和迁移描述。
- [ ] 将 `dataSources` 改为可选观察/安全策略，或从 MVP 移除。
- [ ] 定义 `render` accepted 语义和 `wait_for_observation` 工具。
- [x] ~~增加事件：`page.network.request`、`page.network.response`、`page.network.error`、`page.network.timeout`、`page.observation.timeout`。~~
      → **已废弃**：前 4 个随自动网络观测一起退役；数据只走显式上报的 `page.data`（`page.observation.timeout` 仍是概念，未落到 wire）。
- [ ] 区分 Tool（Agent 操作）与 Observation（Runtime 事实）。
- [ ] 补充请求错误、无请求、页面报错、超时、晚到响应时序。
- [ ] 明确等待结果为 `completed`、`failed`、`timed_out`，并限制重试。

### 1.1 等待模型

- [ ] 确定 `render` 输入：`tag`、`params?`、`props?`。
- [ ] 确定 `render` 返回：`{ accepted: true, page }`。
- [ ] 确定 `wait_for_observation` 输入：页面、匹配条件、`timeoutMs`。
- [ ] 等待失败和超时以结构化结果返回，不以未处理异常中断 ReAct。
- [ ] 只有观察结果中确认出现的 `id` 才能用于后续页面操作。

## 2. Protocol 类型（已完成）

目录：`/Users/lvdongzhou/codePersonal/webassistant/packages/protocol/src/`

- [x] 新增 `observation.ts`，定义 request/response/error/timeout/可见内容类型。
- [x] 网络事件包含 `requestId`、页面、`navigationId`、method、URL、时间和状态。
- [x] 定义 `AgentSession`、`ChatTurn`、当前页面、pending request、观察结果、AgentRun。
- [x] 定义客户端消息：`session.hello`、`chat.send`、`chat.cancel`、`tool.result`、`page.navigated`、`page.data`、`page.emit`、`ping`。
- [x] 定义服务端消息：`session.ready`、`chat.text`、`agent.step`、`tool.call`、`chat.done`、`chat.error`、`pong`。
- [x] `tool.call` 携带 id、工具名、args、timeout；`tool.result` 支持成功/失败/超时。
- [x] 未知消息忽略并记录日志；未知工具返回 `unsupported tool`。
- [x] 增加类型守卫或运行时校验，统一各类 ID 边界。

## 3. Nest Agent Server

目录：`/Users/lvdongzhou/codePersonal/webassistant/packages/agent-server/`

### 3.1 基础迁移

- [ ] JS 迁移为 TS：`src/main.ts`、`agent/agent.service.ts`、`manifest/manifest.service.ts`、`tools/`。
- [ ] 增加独立 `tsconfig.json`，配置 decorators/metadata。
- [x] 创建 App、Config、Health、Manifest、Session、Agent、RPC、Gateway、Tools 模块。
- [ ] 添加 Nest/Fastify/WebSocket 依赖；增加 dev/build/start/typecheck/test 脚本。
- [ ] 保留 `--manifest`、`--port` 参数；配置 CORS、消息大小、日志和错误处理。

### 3.2 ManifestService

- [x] 启动时加载并校验 manifest，缓存读取结果。
- [x] 提供 `getManifest()`、`getPages()`、`getPage(tag)`、版本信息。
- [x] 支持文件变更后重新加载。
- [x] 根据页面 `description`、`props`、`params` 生成 Agent prompt。
- [x] 不要求 `dataSources`；不存在的 tag 返回结构化错误。

### 3.3 Session 与 AgentRun

- [x] 实现 `SessionStore` 接口和内存 `Map` 实现，预留 Redis 替换点。
- [x] 实现创建/恢复、`lastSeenAt`、TTL 清理、历史限制和观察结果限制。
- [x] 记录当前页面、导航来源、pending request、response/error/timeout 和 late response。
- [x] AgentRun 状态：`running`、`waiting-observation`、`waiting-user`（提问回合）、`waiting-plan`（等计划确认）、`completed`、`failed`、`cancelled` —— `waiting-*` 表示"上一轮停在等用户决策"（run 已结束），见 `add-agent-modes-and-plan-turns`。
- [x] 支持从观察事件唤醒等待 AgentRun，支持取消、最大步数和总时长上限；**步数用尽不再算失败**（降级为「已暂停」）。
- [x] 防止同一 Session 的冲突并发运行；结束时清理全部 timer/promise。

### 3.4 Tool RPC

- [x] `RpcService.call(sessionId, name, args, timeoutMs)`：生成 ID、发送 call、等待 result、超时清理。
- [x] `render(tag, params?, props?)`：校验页面，发送 Tool Call，只等待客户端 accepted。
- [x] `wait_for_observation(page?, match?, timeoutMs)`：先查已有上下文，再等 response/error/timeout。
- [x] 请求 error 立即返回 failed；无请求或无有效结果由 observation timeout 结束。
- [x] 空结果是无匹配证据；多候选交给 Agent 询问；禁止猜 ID。
- [x] late response 更新 Session，但不重启完成任务。
- [ ] 分离配置：Tool=8000ms、Network=8000ms、Observation=10000ms、AgentRun=60000ms、最大步数=6、Session TTL=30min。

### 3.5 WebSocket Gateway

- [x] 实现 `session.hello` 新建 Session（**会话 = 连接**：不再恢复），并返回 `session.ready`。
- [x] 校验 manifestVersion；未 hello 前拒绝业务消息。
- [x] 一个 Session 绑定当前连接；**断线即销毁 Session**（abort 在跑的 run + 清理观察等待 + 释放 agent 实例），未完成 Tool Call 失败/超时。
- [x] 实现 ping/pong 与自动重连（重连 = 新会话）；不补发旧 Tool Call。
- [x] 路由 chat、cancel、tool.result、导航和全部 network observation 消息。
- [x] 未知消息不崩溃；所有消息隔离在所属 Session。

## 4. AgentService 与 Prompt

- [x] 将现有 `runAgent` 迁移到 Nest service，AgentRun 绑定 Session。
- [x] Cline SDK 文本增量转 `chat.text`，执行轨迹转 `agent.step`。
- [x] Agent 工具调用接入 RpcService，支持等待观察、取消和总 timeout。
- [x] Prompt 注入 manifest、当前目标、当前页面、最近响应（recentObservations via buildAgentContext）。
- [x] 连接内多轮：会话内长驻 agent runtime（`state.messages` 含 tool-call/result），每轮用 `prepareTurn` 投影最新页面上下文并按 `MAX_TURN_MESSAGES` 裁剪。
- [x] 同一会话禁止并发 run（gateway 显式拒绝 + SDK 内建 "already running" 保护）。
- [ ] Prompt 注入 pending 请求、事件和剩余等待时间（待后续补全）。
- [ ] Agent 规则：缺少 id 时寻找支持 keyword 的候选列表页；render 后不假设完成；必要时 wait；失败/超时可有限重试、换策略或询问；只使用观察结果确认的 ID。
- [x] 入参通道显式化：manifest 的 `params[].in`（`path` / `query`）由 analyzer 从「path 正则 + 页面源码里 route.query.x 的读取」探测得出，prompt 按通道分段；`render` 的 `params` 同时承载两种通道（path 段没声明的键会被 vue-router 丢弃，只能走 query）。详见 openspec `detect-route-query-params`。

### 4.1 模式与回合边界（已实施：`add-agent-modes-and-plan-turns`）

> 目标：复杂任务不再被单轮步数上限**硬中断**（过去 = `chat.error`），并且信息不足时 agent 能主动问用户。

- [x] `agent/mode.ts`：三模式（`act` / `plan` / `auto`）+ 三层判定（显式 > 启发式 > 模型自判），纯函数可单测。
- [x] 收尾工具（`lifecycle.completesRun`）：`propose_plan` / `ask_user` / `finish_turn` → 本轮 `completed` 正常收尾。
- [x] 步数软着陆：`hooks.beforeModel` 在倒数一步注入收尾提醒；`exceeded maxIterations` 降级为「已暂停」（不再 `chat.error`）；`MAX_AGENT_STEPS` 默认 6 → 12。
- [x] plan 硬门禁：`hooks.beforeTool` 拦未确认计划的 `render` / `call_page_method`（`PLAN_GATE=off` 可降级为只提醒）。
- [x] 回合边界统一：计划确认 / 澄清提问 / 进度交接 → `session.plan` / `session.pendingQuestion` + `chat.plan` / `chat.ask`，用户回应走 `chat.send(planId / questionId)`。
- [x] prompt 注入：本轮模式与门禁状态、当前计划与进度、上一个提问与回答 + 规则 10~14。
- [x] chat-client：`PlanCard` / `AskCard` / `ModeSwitch` + `lib/turnState.ts`（纯函数状态机）+ 两条渲染面接线。
- [x] 计划的**在线编辑**（2026-09 补上，`add-interactive-plan-revision`）：计划卡「修改计划」→ `chat.send(revisePlanId)` → `revise_plan` 按 step id **增量合并**（`planId` 不变、`revision+1`、进度不丢），修订轮硬拦 `propose_plan`；改完重新确认（清 `approvedAt`）；「重新生成计划」保留全量重来。
- [x] 计划里的**人工步骤**（2026-09 补上，`add-plan-manual-steps`）：agent 做不了的一步（写后端 / 清单里没有对应方法 / 需要人本身 / `call_page_method` 被拒）→ 收尾工具 `handoff_step` 交回用户（该步 `waiting-user` + `instructions` 指引，至多一个步骤在等你）→ 用户在页面上做完点计划卡「我已完成，下一步」（`chat.send(planId + stepDoneId)`）→ 服务端标 `done` 并起一轮，模型**先校验**再继续；没做成就 `handoff_step(issue)` 让该步回「需你重做」（带原因/期望）。服务端保证：`waiting-user` 的步骤不接受 `finish_turn.done` / `doneAll` 勾选。判定权在 agent（规则 16/17），不在计划里预先声明谁做哪一步。
- [ ] 后续（若需要）：服务端**自动接力**（`AUTO_CONTINUE_MAX_TURNS`：run 结束自动起下一轮）；`MODE_CLASSIFIER=llm` 的判定层 4；宿主页面上的**视觉引导**（高亮目标控件 / 浮层指引 —— 本次只做到"面板内提示 + 指引文本 + 必要时先 render 到目标页"）；提示词的**逐步审批**模式（每步都等用户点确认）。

## 5. 数据上报（原「Runtime 透明观察」—— 已改向）
目录：`/Users/lvdongzhou/codePersonal/webassistant/packages/wc-runtime-core/`

**决定（已实施）**：不做透明观察。`NetworkObserver`（包装 `window.fetch` / `XMLHttpRequest` 全量观测）
已删除，`page.network.*` 四条 wire 消息、`observeNetwork` 选项、`pendingRequests`、prompt 里的网络分支
一并退役。理由见 `docs/agent-session.md` §6：全量拦截宿主页面请求会把不相关/敏感数据带出浏览器，
靠事后白名单补救不可靠；改为**调用点显式上报**后，不调 = 零数据出网。

- [x] ~~定义框架无关 `NetworkObserver`~~ → **已删除**（连同 fetch/XHR 包装）。
- [x] 数据上报唯一通道：`apiBus.report({ source, data })`（`apiBus.ts`；`report()` 返回 boolean 便于自检）。
- [x] runtime 侧只做元信息补充（`page` / `at`）+ 体积硬上限（16KB / 深度 4）。
- [x] `dataSources` 降级为**可选**加固（命中才裁）；未声明即原样透传。
- [x] 单测锁死行为：`test/report.test.js`（不改写全局 fetch / 不调 report 无数据 / 命中裁剪 / 未命中透传 / 超限截断 / dispose 后 detach）。
- [ ] 后续（若需要）：`page.observation.timeout` 结构化超时事件落到 wire。

## 6. Runtime Tool 执行与 chat-client

### 6.1 Runtime

- [ ] 接收 `tool.call(render)`，校验参数并调用现有 `runtime.navigate()`。
- [ ] 导航被接受后立即返回 `tool.result`，不等待 ready/接口完成。
- [ ] 发送 `page.navigated`，区分 `page`、`host`、`agent` 来源。
- [x] 发送 network request/response/error/timeout；维护 `requestId`、`navigationId` 关联。
- [ ] 页面事件如保留则发送 `page.event`。

### 6.2 chat-client

目录：`/Users/lvdongzhou/codePersonal/webassistant/packages/chat-client/src/`

- [x] 新增 `agentSocket.ts`、`useAgentSocket.ts`，WebSocket 为唯一客户端传输。
- [x] **不持久化会话**：`sessionId` 不写 `sessionStorage`/`localStorage`，`session.hello` 不带会话标识；刷新 / 重连 = 新会话（`onSessionReset` → 清空并提示）。
- [x] 支持首次连接、自动重连退避、心跳和连接状态；`startNewSession()` 提供「新会话」入口。
- [x] 支持 chat.text、agent.step、chat.done、chat.error、chat.cancel。
- [ ] 执行 render Tool Call 并立即返回 result；未知工具返回 unsupported tool。
- [ ] 将导航、网络观察、错误和 timeout 发送给服务端。
- [x] **过程 / 结果分离**：`chat.text` 分 `text` / `reasoning` 两个 channel；`agent.step` 带 `phase/tool/target/durationMs`；
  对话区拆「结果气泡 + 过程区」（`lib/chatTrace.ts` + `<TraceTimeline>`），过程行不再以 `> …` 拼进结果气泡。
- [x] UI 展示 Agent 步骤、waiting-observation、错误、超时和取消状态；超时后恢复交互。

## 7. Demo 验收

目录：`/Users/lvdongzhou/codePersonal/webassistant/packages/demo-app/`

- [ ] `UserList.vue` 增加普通 `keyword` prop，接入已有过滤/查询逻辑，不增加 Agent 上报代码。
- [ ] manifest 声明 user-list 的 keyword 能力和 user-detail 的必需 id；不要求 `dataSources`。
- [ ] 增加 `/api/users?name=张三` mock，让页面照常通过原有 request/fetch 获取数据。
- [ ] 正常链路：打开 `user-list(keyword=张三)` → request → response → 提取 `id=1` → 打开 `user-detail(id=1)`。
- [ ] 异常链路：空列表、多个同名、403、500、请求不返回、页面直接报错、晚到响应、用户新目标、取消、断线重连。
- [ ] 每种异常都验证：不永久卡住、不猜 ID、不覆盖用户后续导航、可继续操作、Session 不污染。

## 8. 测试与完成定义

- [ ] Protocol：合法/缺字段/未知消息、Tool result 分支、观察事件、ID/时间/timeout 校验。
- [ ] Session：创建、恢复、TTL、导航、pending 生命周期、late response、历史/观察限制。
- [ ] Timeout：response 先到、error 先到、timeout 先到、晚到响应、多请求隔离、断线、总 timeout、timer 清理。
- [ ] Observer：fetch/XHR 全生命周期、JSON/非 JSON、大小/脱敏、dispose、重复安装、页面切换。
- [ ] Gateway：hello、chat、render accepted、response 唤醒、error/observation timeout、cancel、恢复、未知消息。
- [ ] E2E：张三详情、空结果、多候选、接口失败、请求超时、页面报错和取消。
- [ ] 安全：消息/响应/步数/时长/重试限制；不上传敏感请求头和敏感响应。
- [ ] 可观测性：连接、Session、AgentRun、Tool、request 关联 ID，记录等待/恢复/结束/timeout/late。
- [ ] 更新 `README.md`、`PROJECT.md`、`docs/agent-session.md`，说明 WebSocket、非阻塞 render、透明观察和 timeout。
- [ ] 运行 `pnpm typecheck`、`pnpm test`、Agent build/test 和 Demo 端到端测试。

## 9. 推荐顺序与最小闭环

```text
协议语义 → protocol 类型 → Nest 基础架构 → Session/AgentRun
→ Tool RPC/timeout → Gateway → AgentService/Prompt
→ Runtime Observer → Runtime Tool → chat-client → Demo → 测试/文档
```

最小闭环：

```text
session.hello → session.ready → chat.send
→ Agent 读取 manifest
→ render(user-list, keyword=张三)
→ 客户端立即返回 accepted
→ 页面 / 宿主显式 apiBus.report({ source: 'user-list', data })
→ page.data（含 id）
→ Agent 读取 id
→ render(user-detail, id=1)
→ chat.done
```

必须同时通过：

```text
page.observation.timeout（无任何上报时的托底）
chat.cancel
WebSocket 断线重连
```
