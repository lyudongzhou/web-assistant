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
| F9 | wc-runtime-core | observer.ts | NetworkObserver 默认 `autoStart: false` | ✅ |
| F10 | wc-runtime-vue | context.ts | 导出 `apiBus`；context 加 `reportApiData` 方法 | ✅ |
| F11 | wc-runtime-vue | index.ts | 导出 `apiBus` + `ApiReport` | ✅ |
| F13 | demo-app | UserList.vue | fetch 后调 `apiBus.report()` | ✅ |
| F14 | demo-app | UserDetail.vue | fetch 后调 `apiBus.report()` | ✅ |
| F15 | demo-app | manifest.json | user-list + user-detail 加 `dataSources` | ✅ |
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
| V4 | NetworkObserver 默认关闭 | 无 page.network.* 消息 | ✅（默认 autoStart: false） |
| V5 | dataSources 摘要正确 | 只暴露声明字段 | ✅ |
