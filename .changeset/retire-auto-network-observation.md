---
'@webassistant/wc-runtime-core': minor
'@webassistant/wc-runtime-vue': minor
'@webassistant/chat-client': minor
'@webassistant/protocol': minor
---

refactor(observe)!: 退役自动网络观测 —— 数据只由调用点显式 `apiBus.report` 上报

**破坏性变更**
- 删除 `NetworkObserver`（不再包装 `window.fetch` / `XMLHttpRequest`）与 `CreateRuntimeOptions.observeNetwork`；
  随之删除各类型/句柄上的 `observer` 字段、`network-observation` 事件、`WcActivityKind` 的 `'network'`。
- 协议删除 `page.network.request|response|error|timeout` 四条客户端消息与 `PageNetwork*` 类型、
  `AgentSession.pendingRequests`；`ObservationMatch` 由 `requestId/method/url` 改为 `source/event/contains`。
- chat-client 删除 `onNetworkObservation` / `sendObservation`。
- **数据上报只有一条路**：调用方（宿主 / 页面）在需要的调用点显式 `apiBus.report({ source, data })`；
  **不调 = 零数据出浏览器**（天然 fail-closed，无需维护白名单）。

**原因**：全量拦截宿主页面的请求（真实站点往往有大量内部接口）会把不相关甚至敏感的数据带出浏览器，
而靠事后白名单 / 脱敏补救既不可靠（fetch 分支曾漏检黑名单）、也难以维护；同时改写全局 fetch 还带来
阻塞流式响应、多实例抢占、`stop()` 后残留包装等副作用。

**其他改动**
- `apiBus.report()`：`url` 改可选、新增 `source`；返回 `boolean`（false = 当前无人监听）。
- `apiBus.attach()` 增加**覆盖告警**（单 sink 语义）：业务侧误调 `attach()` 顶掉内核 sink 时立刻可见。
- **chat-client 转出 `apiBus` / `ApiReport`**：只装面板的宿主（用法 A）不必为了上报再引一个包。
- `sanitizeData` 从 `observer.ts` 搬到 `sanitize.ts`，并修掉 O(n²) 的体积统计（现为线性、上限更可预期）。
- runtime 侧对上报数据只做：补 `page`/`at` + 体积/深度硬上限（16KB / 深度 4）+ **可选**的
  `dataSources` 裁剪（命中才裁；未命中即原样透传）。
- `wait_for_observation` 工具描述与匹配条件改为「等待显式上报的数据 / 页面事件」。

**迁移**：把原来的自动上报（如 axios 拦截器里统一 `apiBus.report`）改为在**明确的调用点**上报，
并只传你愿意公开的字段；页面/宿主未调用则 agent 侧不会收到任何业务数据。
