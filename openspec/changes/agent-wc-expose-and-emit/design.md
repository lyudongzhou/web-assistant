# Design: agent-wc-expose-and-emit

## Context

agent 与 wc 之间没有直接通道，全部经 `chat-client → WebSocket → agent-server` 转一道。现有控制面/观测面：

| 面 | 通道 | 现状 |
|---|---|---|
| 控制面（agent→页面） | `render` tool → `runtime.navigate({tag, params, props, source:'agent'})` → `resolveProps` → element property | ✅ 通 |
| 观测面（页面→agent） | `apiBus.report` → `page.data`（dataSources 摘要）/ `page.network.*`（NetworkObserver） | ✅ 通（有条件） |
| 通知面（页面→agent） | `context.emit` → 宿主回调；Vue `defineEmits` | ⚠️ 半通（ws `page.event` 已删，`defineEmits` 未捕获） |
| 方法调用面（agent→页面） | — | ❌ 不通（`defineExpose` 无人读取） |

Vue 的 `defineCustomElement` 会把 setup 里 `defineExpose` 的结果挂在**元素实例的 `.exposed` property** 上，机制是现成的，runtime 只需伸手取。

## Goals / Non-Goals

**Goals:**

- agent 能通过 `call_page_method` 工具调用当前页面 `defineExpose` 暴露的方法，拿到返回值（成功/异常），并在后续对话中引用。
- 页面 `defineEmits` 事件能经 ws 回传 agent-server 并进入 session，agent 可把它作为「通知面」参考。
- manifest v2 记录页面 `exposes` / `emits` 合同，analyzer 自动解析，prompt 自动注入。
- 全链路向后兼容（联合类型新增成员，未知 `t` 忽略）。

**Non-Goals:**

- 不解析 `defineExpose` 函数体（只取 key + JSDoc 描述）。
- 不做静默页面/后台执行（沿用「可见执行」前提，见 PROJECT.md D6）。
- 不把 Vue 实例本身序列化给 agent（函数不进 ws，只发 key + 签名 + 描述）。
- `render` / `wait_for_observation` 语义不变。

## Decisions

### D1: expose 走「工具 + RPC」，与 render 同一套

`call_page_method` 与 `render` 一样是 `createTool`，execute 走 `rpc.call(sessionId, name, args, timeout)`（默认 8s，`TOOL_CALL_TIMEOUT_MS` 可配）。断线时 `unregister` 清掉 pending，不悬挂。

### D2: 方法不序列化，只传「能力清单」

- runtime 侧 `getPageExposed` 返回 `Record<string, unknown>`（函数引用留在浏览器）。
- 通过 `page.exposed` 消息把 **key 列表**（+ manifest 里 analyzer 解析出的 signature/description）上报，agent 据此构造调用。
- chat-client 收到 `tool.call(call_page_method)` 后，从当前页 element.exposed 取 `name` 并执行，`args` 数组透传，结果 `ok/data` 或 `ok/error` 回 `tool.result`。

### D3: 「当前页面」由容器维护，expose 归属用 `tag`

容器在 `applyNavigation` 里已持有当前页面 element；`getPageExposed(page?)` 缺省取当前页。`page.exposed` 消息带 `tag`，session 按 tag 存（与 `pageContext` 同构）。跨页调用（page 参数）MVP 仅允许「已渲染过的 tag」——未渲染则返回错误，不强求懒加载。

### D4: emit 恢复为 `page.emit`，捕获 `defineEmits`

- runtime 在页面 app 挂载后，用 Vue 的 `emits` 选项/`defineEmits` 声明注册监听：对每个声明的事件名，在 element 上 `addEventListener`（CE 事件机制）或包一层 `emit` 转发。
- 简化实现：Vue CE 本身把 `emits` 事件派发为原生 CustomEvent，runtime 在 element 上监听 `*`（或按 manifest emits 列表监听），转发为 `page.emit { tag, event, payload }`。
- manifest `emits[]` 由 analyzer 静态解析（名字 + JSDoc），不保证运行时与声明 100% 对齐，声明是「agent 参考」而非「强约束」。

### D5: 调用结果进 session.history，emit 进 observations

- `call_page_method` 是「动作」不是「事实」：成功/失败结果作为 tool result 自然进 LLM 上下文（Cline SDK 工具结果回传），同时在 session 记一条结构化记录便于复用。
- `page.emit` 事件按 `recordObservation` 路径入 `observations[]`（新增 `PageEmit` 联合成员），可被 `wait_for_observation` 的 `contains` 匹配到（可选增强，MVP 先入历史）。

### D6: analyzer 只做静态浅解析

`parseComponent.ts` 已有 babel TS 解析：对 `<script setup>` 的 `defineExpose({ a, b })` 取对象字面量 key；`defineEmits<{ 'foo': [id: string] }>` 取泛型键或字符串数组元素。JSDoc 注释就近提取作 description。不 eval、不解析函数体。

## Risks / Trade-offs

- **暴露面风险**：页面 `defineExpose` 的一切方法都进 manifest 才能被 agent 调到（白名单）；未声明方法即使页面内部有，agent 也看不见。但仍需提醒页面作者：expose 的方法默认可被 agent 调用，敏感操作需自行加 guard。
- **方法与序列化**：函数/非结构化返回值经 ws 时会被结构化克隆/JSON 序列化，返回非 JSON 安全值（如 DOM 节点）会失败——工具描述里注明「返回值需 JSON 可序列化」。
- **emit 全量监听**：`*` 监听可能放大事件量；用 manifest emits 白名单监听可限流（D4 建议白名单优先，若 events 声明为空则回退 `*`，加节流）。
- **跨页调用**：MVP 限定已渲染 tag；若未来需要任意页，需引入页面实例注册表（每 tag 的 element 引用）。
- **兼容性**：`ClientMessage` 新增成员对旧 agent-server 无影响（未知 t 忽略）；`ToolArgs` 新增成员对旧 chat-client 无影响（旧端不认识 `call_page_method` 时返回 tool 不存在错误）。
