# agent-wc-expose-and-emit

## Why

当前 agent 对 wc 的控制面只有 `render`（prop + params 推输入），观测面只有 `page.data` / `page.network.*`（数据快照）。Vue 组件三块标准交互里：

- **prop**：已通（`resolveProps` 归一 + element property 下发，对象/数组引用安全）。
- **emit**：半通 —— 页面侧 `context.emit` 存在，但 ws 协议里 `page.event` 已从 `ClientMessage` 联合删除，页面 `defineEmits` 也未被 runtime 捕获，agent 收不到页面事件流。
- **expose**：完全不通 —— 页面 `defineExpose` 出的方法 agent 看不见、调不到。

结果：agent 只能「跳页面 + 塞 props + 等数据」，无法精确调用当前页面的方法（翻页、筛选、刷新、取值）。这限制了 agent 在页面上的可操作性，也是「页面可控入参声明成 props」这条控制面之外缺的一条腿。

## What Changes

- **协议（protocol）**：
  - `ToolName` 新增 `'call_page_method'`；`ToolArgs` 新增 `CallPageMethodToolArgs { page?, name, args?, timeoutMs? }`。
  - `ClientMessage` 新增 `{ t: 'page.emit'; tag; event; payload? }`（页面 `defineEmits` 事件回传）与 `{ t: 'page.exposed'; tag; keys: string[] }`（当前页 expose 能力清单上报）。
  - `manifest.ts`：`ManifestPage` 新增 `exposes?: ManifestMethod[]`（name / signature / description）与 `emits?: ManifestEvent[]`（name / payloadType? / description），供 agent 规划与调用合同。
- **runtime（wc-runtime-core / vue）**：
  - `RuntimeServices` 新增可选 `getPageExposed(page?): Record<string, unknown> | null`；`RuntimeEventMap` 新增 `'page-exposed-changed'` 事件（仅透出方法 key 列表，函数不可序列化）。
  - Vue 容器维护「当前页面 element」，从 `element.exposed` 取暴露对象；`applyNavigation` 完成后广播 `page-exposed-changed`。
- **chat-client**：
  - `useRuntimeHost` 暴露 `currentPageExposedKeys`；`useAgentChat` 处理 `call_page_method` 的 `tool.call`（执行 exposed 方法 → `socket.sendToolResult`）。
  - ws 客户端转发 `page.emit` / `page.exposed` 到 agent-server。
- **agent-server**：
  - 注册第三个工具 `call_page_method`（execute → `rpc.call(sessionId, 'call_page_method', input, TOOL_TIMEOUT_MS)`）。
  - gateway 新增 `page.emit` / `page.exposed` handler；session 记录 emit 事件与 call 结果。
  - `buildAgentContext` 把当前页 `exposes[]` / `emits[]` 注入 prompt（`[页面方法]` / `[页面事件]` 段）。
- **analyzer**：
  - `parseComponent.ts` 增加 visitor 识别 `defineExpose({...})`（key + JSDoc 描述，不解析函数体）与 `defineEmits` 声明（事件名 + 载荷类型，可宽松为仅名字）。
  - `analyze.ts` 把 `exposes` / `emits` 写入 manifest v2。
- **demo-app**：`UserList.vue` 增加 `defineExpose({ refresh, setKeyword })` 与示例 emit；验收台可模拟 `call_page_method`。

> 兼容性：`ClientMessage` / `ServerMessage` / `ToolArgs` 均为**联合类型新增成员**，旧客户端/服务端对未知 `t` 忽略并记日志（协议已有约定），非 breaking。

## Capabilities

### New Capabilities

- `agent-wc-expose`: agent 通过 `call_page_method` 调用页面 `defineExpose` 暴露的方法；runtime 透出当前页 `exposed`，analyzer 解析方法清单进 manifest，prompt 注入可调用方法。
- `agent-wc-emit`: 页面 `defineEmits` 事件经 runtime → ws `page.emit` → session 回传 agent；manifest 记录事件合同，prompt 注入可观察事件。

### Modified Capabilities

（无既有 spec 变更。）

## Impact

- `packages/protocol`：`websocket.ts`（ToolName / ToolArgs / ClientMessage）、`manifest.ts`（ManifestPage 新增 exposes/emits）、`index.ts`（导出）。
- `packages/wc-runtime-core`：`types.ts`（RuntimeServices / RuntimeEventMap）、`events.ts`、`runtime.ts`（applyNavigation 后广播）。
- `packages/wc-runtime-vue`：`container.ts`（页面 element 维护 + getPageExposed）、`context.ts`（可选转发）。
- `packages/chat-client`：`composables/useRuntimeHost.ts`、`composables/useAgentChat.ts`、`lib/agentClient.ts`（ws 转发）。
- `packages/agent-server`：`agent/agent.service.ts`（新工具）、`gateway/agent.gateway.ts`（新 handler）、`session/session.service.ts`（emit/调用记录）、`manifest/manifest.service.ts`（prompt 注入）。
- `packages/analyzer`：`parseComponent.ts`、`analyze.ts`。
- `packages/demo-app`：`src/pages/UserList.vue`、`wc-demo.html`、manifest 重新生成。
- 文档：`docs/agent-session.md`、`PROJECT.md`、各包 README。
