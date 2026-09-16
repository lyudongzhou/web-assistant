# apiBus 手动上报实施任务清单

## 阶段一：前端数据上报链路

| # | 包 | 文件 | 改动 | 状态 |
|---|---|---|---|---|
| F1 | protocol | observation.ts | 新增 `PageDataSnapshot` 类型 | ✅ |
| F2 | protocol | websocket.ts | ClientMessage 新增 `{ t: 'page.data' }` | ✅ |
| F3 | protocol | manifest.ts | 页面 schema 新增可选 `dataSources[]` | ✅ |
| F4 | wc-runtime-core | apiBus.ts（新建） | `report(payload)` / `attach(sink)` 全局单例 bus | ✅ |
| F5 | wc-runtime-core | dataSources.ts（新建） | URL 匹配 + fields/mask/maxRows 摘要/脱敏 | ✅ |
| F6 | wc-runtime-core | types.ts | `RuntimeServices` 加 `reportApiData`；事件总线加 `page-data` | ✅ |
| F7 | wc-runtime-core | runtime.ts | `apiBus.attach(sink)` → 匹配+摘要 → bus.emit('page-data') | ✅ |
| F8 | wc-runtime-core | index.ts | 导出 apiBus + dataSources 相关 | ✅ |
| F9 | wc-runtime-core | observer.ts | ~~NetworkObserver 默认 `autoStart: false`~~ → **该文件已随自动观测退役删除** | 已删 |
| F10 | wc-runtime-vue | context.ts | 导出 `apiBus`；context 加 `reportApiData` 方法 | ✅ |
| F11 | wc-runtime-vue | index.ts | 导出 `apiBus` + `ApiReport` | ✅ |
| F13 | demo-app | UserList.vue | fetch 后**显式** `reportData('user-list', …)` | ✅ |
| F14 | demo-app | UserDetail.vue | fetch 后**显式** `reportData('user-detail', …)` | ✅ |
| F15 | demo-app | manifest.json | ~~user-list + user-detail 加 `dataSources`~~ → 未声明（`dataSources` 已降级为可选加固） | — |
| F17 | chat-client | agentSocket.ts | 新增 `sendPageData(snapshot)` | ✅ |
| F18 | chat-client | WebAssistant.vue | 监听 `page-data` → `sendPageData()` | ✅ |
| F19 | chat-client | useRuntimeHost.ts | 新增 `onPageData` 回调 | ✅ |

## 阶段二：后端数据接收链路

| # | 包 | 文件 | 改动 | 状态 |
|---|---|---|---|---|
| B1 | agent-server | agent.gateway.ts | 新增 `handlePageData` handler（`@SubscribeMessage('page.data')`） | ✅ |
| B2 | agent-server | session.service.ts | `recordObservation` 已支持 `PageDataSnapshot`（类型联合已含） | ✅ |
| B3 | agent-server | manifest.service.ts | `buildAgentContext` 注入 dataSources 描述 + `[页面数据]` 格式化 | ✅ |
| B4 | agent-server | agent.service.ts | prompt 由 `buildAgentContext` 构建，自动含 dataSources | ✅ |
| B5 | agent-server | ws/direct-ws.adapter.ts | `page.data` 消息类型由 NestJS `@SubscribeMessage` 自动路由 | ✅ |

## 流程验证

| # | 验证项 | 预期 | 结果 |
|---|---|---|---|
| V1 | 全仓 typecheck | 通过 | ✅ |
| V2 | page.data 消息正确发送和接收 | WS 收到 page.data | ✅ |
| V3 | agent 看到 apiBus 数据并提取 id | render(user-detail, id=1) | ✅ |
| V4 | ~~NetworkObserver 默认关闭~~ → **已删除**，无 `page.network.*` 通道 | 不再存在该消息类型 | ✅ |
| V5 | dataSources 摘要正确 | 只暴露声明字段 | ✅ |
| V6 | 不调用 `apiBus.report` → agent 侧零业务数据 | 只有 `page.navigated` / `page.exposed` | ✅（单测 `report.test.js`） |

---

## 阶段三：自动网络观测退役（后续变更，已完成）

> 决策：`NetworkObserver`（包装 `window.fetch` / `XMLHttpRequest` **全量**观测）整体删除。
> 全量拦截宿主页面请求会把不相关/敏感数据带出浏览器，事后的白名单 / 脱敏补救既不可靠也难维护。
> 改为「**调用点显式** `apiBus.report`」：不调 = 零数据出网，天然 fail-closed。

| # | 包 | 文件 | 改动 | 状态 |
|---|---|---|---|---|
| R1 | wc-runtime-core | observer.ts | 删除（fetch/XHR 包装；`sanitizeData` 搬到 `sanitize.ts`） | ✅ |
| R2 | wc-runtime-core | types.ts | 删 `observeNetwork` / 各 `observer` 字段 / `network-observation` 事件 | ✅ |
| R3 | wc-runtime-core | kernel.ts | 删 observer 装配；apiBus sink = 补元信息 + 可选 dataSources 裁剪 + 体积硬上限 | ✅ |
| R4 | wc-runtime-core | apiBus.ts | `url` 改可选 + 新增 `source`；`report()` 返回 boolean | ✅ |
| R5 | protocol | observation.ts / websocket.ts / session.ts | 删 4 个 `PageNetwork*` 与 `page.network.*` 消息、`pendingRequests`；`ObservationMatch` 改 `source` / `event` / `contains` | ✅ |
| R6 | agent-server | gateway / session.service / manifest.service / agent.service | 删 4 个 network handler、pending 逻辑、prompt 网络分支；工具描述改为「等待显式上报」 | ✅ |
| R7 | chat-client | useRuntimeHost / useWebAssistant / agentSocket | 删 `onNetworkObservation` / `sendObservation` / `network` 活动类型 | ✅ |
| R8 | demo-app | httpClient.ts / UserList.vue / UserDetail.vue / host-main.ts | 去掉 axios 拦截器自动上报 → 调用点显式 `reportData` | ✅ |
| R9 | 文档 | agent-session / INTEGRATION_GUIDE / PROJECT / TODO / README | 全量改写为「显式上报」口径 | ✅ |

