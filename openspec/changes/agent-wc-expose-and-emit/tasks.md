## 1. 协议层（packages/protocol）

- [x] 1.1 `protocol/src/websocket.ts`：`ToolName` 联合新增 `'call_page_method'`
- [x] 1.2 `protocol/src/websocket.ts`：新增 `CallPageMethodToolArgs { page?, name, args?, timeoutMs? }` 并并入 `ToolArgs`
- [x] 1.3 `protocol/src/websocket.ts`：新增 `PageEmitMessage { t:'page.emit'; tag; event; payload? }` 与 `PageExposedMessage { t:'page.exposed'; tag; keys: string[] }`，并入 `ClientMessage`
- [x] 1.4 `protocol/src/manifest.ts`：新增 `ManifestMethod { name; signature?; description? }` 与 `ManifestEvent { name; payloadType?; description? }`；`ManifestPage` 新增 `exposes?: ManifestMethod[]` 与 `emits?: ManifestEvent[]`
- [x] 1.5 `protocol/src/observation.ts`：`PageObservation` 联合新增 `PageEmit`（type='page.emit'，含 page/event/payload/at）
- [x] 1.6 `protocol/src/index.ts`：检查并按需 re-export 新增类型

## 2. Runtime 桥（wc-runtime-core / wc-runtime-vue）

- [x] 2.1 `wc-runtime-core/src/types.ts`：`RuntimeServices` 新增可选 `getPageExposed(page?): Record<string, unknown> | null`
- [x] 2.2 `wc-runtime-core/src/types.ts`：`RuntimeEventMap` 新增 `'page-exposed-changed': { tag; keys: string[] }`
- [x] 2.3 `wc-runtime-vue/src/container.ts`：维护「当前页面 element」，实现 `getPageExposed`（`(element as any).exposed`）— **实施修正（2026-09-07，浏览器验证发现）**：Vue 3.5.41 的 CE 上 `element.exposed` **不存在**（defineExpose 原始对象在 `element._instance.exposed`，expose 成员被拷成元素自身 property）。已改为 `element.exposed ?? element._instance?.exposed` 双路读取 + 单测锁定（adapter.test.js）
- [x] 2.4 `wc-runtime-core/src/runtime.ts`：在 `applyNavigation` 完成、视图就绪后 `bus.emit('page-exposed-changed', { tag, keys })`；`keys` 仅字符串化方法名
- [x] 2.5 ~~`wc-runtime-vue/src/context.ts`：`RuntimeServicesContext` 增加可选 `getPageExposed` 转发（指向 servicesRef）~~ — **实施调整**：页面侧 `context` 是给页面内读取的，加 `getPageExposed` 是循环引用；真正的外部入口放在 `Runtime.getPageExposed()`（core 已实现），adapter 透出 `.exposed` 已覆盖此目标。
- [x] 2.6 ~~`wc-runtime-vue/src/definePage.ts`：在 `defineCustomElement` 的 `configureApp` 里按 `api.context` 暴露 `getPageExposed`（若 adapter 提供）~~ — **实施调整**：实现到 vue adapter 的 `getPageExposed(handle, tag?)` 方法（vue 容器已在 `patchContainer` 维护 `currentPageElement`），由 `Runtime` 委托调用。比塞到 `definePage` 一次性回调更合适：element 引用应集中在 adapter。
- [x] 2.7 单测：`wc-runtime-core` 加 `getPageExposed` 默认返回 `null`、`page-exposed-changed` 事件在 view 就绪后触发、`keys` 不含非函数字段；`vue` 侧冒烟（容器伪造 element.exposed）

## 3. Chat-client 桥

- [x] 3.1 `chat-client/src/composables/useRuntimeHost.ts`：暴露 `currentPageExposedKeys: Ref<string[]>`；`view` 事件回调里更新；setState 不变
- [x] 3.2 `chat-client/src/composables/useAgentChat.ts`：`handleToolCall` 增加 `name === 'call_page_method'` 分支 → 通过 host 调 `getPageExposed(tag)` 取方法并 `apply(args)` → `socket.sendToolResult`（成功/异常都回）
- [x] 3.3 `chat-client/src/lib/agentClient.ts`（ws 客户端）：转发 `page.emit` / `page.exposed` 到 agent-server；在 `_handleServerMessage` 不需要新分支（这两个是 client→server）
- [x] 3.4 `chat-client/src/components/WebAssistant.vue` 或 host：`getPageExposed(tag?)` 透传 runtime API；提示语「正在调用页面方法」加进消息流

## 4. Agent-server

- [x] 4.1 `agent-server/src/agent/agent.service.ts`：注册 `callPageMethodTool`（`createTool<CallPageMethodToolArgs>`），execute → `rpc.call(sessionId,'call_page_method', input, TOOL_TIMEOUT_MS)`；加入 `tools: [...]`
- [x] 4.2 `agent-server/src/gateway/agent.gateway.ts`：新增 `@SubscribeMessage('page.emit')` / `@SubscribeMessage('page.exposed')` handler，分别调用 `session.recordPageEmit` / `session.recordPageExposed`
- [x] 4.3 `agent-server/src/session/session.service.ts`：新增 `recordPageEmit(session, {tag, event, payload, at})` 与 `recordPageExposed(session, {tag, keys})`；可复用 `recordObservation` 路径（emit 类型并入 `PageObservation`）
- [x] 4.4 `agent-server/src/session/session.service.ts`：`waitForObservation` 的 `contains` 匹配扩展为对 `page.emit.payload` 做安全字符串包含（可选增强；MVP 可先只支持 network）
- [x] 4.5 `agent-server/src/manifest/manifest.service.ts`：`buildAgentContext` 注入当前页 `exposes[]` / `emits[]` 描述为 `[页面方法]` / `[页面事件]` 段
- [x] 4.6 `agent-server/src/agent/agent.service.ts`：`agent.step` 文案按工具名映射 `render`/`wait_for_observation`/`call_page_method`
- [x] 4.7 `agent-server/src/main.ts` / 配置：默认超时/节流沿用 `TOOL_CALL_TIMEOUT_MS=8000`、`OBSERVATION_WAIT_TIMEOUT_MS=10000`

## 5. Analyzer / Manifest 生成

- [x] 5.1 `analyzer/src/parseComponent.ts`：新增 visitor 识别 `defineExpose({...})` 对象字面量 → 提取 key（Identifier / StringLiteral / SpreadElement 忽略）；就近 JSDoc 注释作 description — **实施增强**：`defineExpose({ refresh })` 标识符引用回查顶层函数声明（`collectLocalFunctions`），signature/JSDoc 从声明处取（如 `(kw: string) => Promise<number>`），不再退化成裸名字；`leadingComment` 只取紧贴声明的最后一条注释（分区注释不算描述）
- [x] 5.2 `analyzer/src/parseComponent.ts`：识别 `defineEmits(...)` —— 数组字面量形式取字符串；泛型 `defineEmits<{ 'x': [T] }>()` 形式取 TSPropertySignature 键；payload 类型 MVP 暂存字符串 — 实际已含数组/对象/泛型属性/调用签名四种写法，payloadType 序列化支持元组（`[status: "paid" | "all", keepPage?: boolean]`）
- [x] 5.3 `analyzer/src/analyze.ts`：把 `exposes` / `emits` 写入 `ManifestPage` — **实施定案：双写**。`events` 保持名字数组（runtime 的 CE 事件监听白名单，wc-runtime-core → vue/container buildListeners 依赖它），`emits` 写富信息（payloadType/description），空时省略字段
- [x] 5.4 `analyzer` 单测：覆盖 `defineExpose` 多种写法（含 spread 跳过、空对象、`defineEmits` 字符串数组 + 泛型）— 落地 `test/parseComponent.test.js` + `test/analyze.test.js`（锁死 events/emits/exposes 双写契约），`pnpm build && node --test`（仓库既有约定，零新依赖）
- [x] 5.5 `demo-app` 重新 `pnpm analyze`，核对 `manifest.json` 中 `UserList` / `UserDetail` 出现 exposes/emits — user-list: `refresh(keywordText?: string) => Promise<number>` / `setKeyword(kw: string) => Promise<number>`；其余页面 emits 齐全。注：UserList 源码变更导致 AI 缓存未命中且无 DEEPSEEK_API_KEY，该页 keywords 走静态兜底（其余页面 AI 字段经缓存保留）
- [x] 5.6（新增）`vite-plugin-wc/src/manifest.ts` 与 analyzer 保持同一套映射（events 名字数组 + emits/exposes 富信息）；`build:libs` 依赖顺序修正为 analyzer 先于 vite-plugin-wc（原来后者的 tsc 会拿到旧 `ParsedComponent` 类型）

## 6. Demo & 验收

- [ ] 6.1 `demo-app/src/pages/UserList.vue`：`<script setup>` 增加 `defineExpose({ refresh, setKeyword })`；演示用 `emit('selection-change', rows)`（配套 `defineEmits<{...}>()`）— **部分完成（2026-09-07）**：`defineExpose({ refresh, setKeyword })` 已加（refresh/setKeyword 带返回值供 agent 引用）；`selection-change` 演示未加（el-table 需加多选列，留待 6.4 前一并做），manifest 验收用现有 4 个 emit 事件
- [ ] 6.2 `demo-app/wc-demo.html`：加「模拟 call_page_method」按钮（不起 agent，直接走 runtime + ws 兼容路径验证执行器；chat-client 注释里已留钩子）— **前置已就绪（2026-09-07）**：`window.__waRuntime = runtime` 已挂到验收台，控制台可直接 `__waRuntime.getPageExposed()` 取方法并调用（与 chat-client 执行器同一入口）；按钮本体待做
- [x] 6.3 端到端（手测）：`pnpm preview:ce` + `pnpm dev:agent` + `pnpm dev:client` → 自然语言「把第 3 页筛成已付款」→ agent `call_page_method('setKeyword'/'refresh')` → `wait_for_observation` 等接口 → 下一轮对话引用返回值 — **已通过（2026-09-07，真实 DeepSeek）**：实际指令「不要重新打开页面，直接调用当前页面暴露出来的方法，把用户列表筛选成姓赵的」→ agent 自己选 `call_page_method('setKeyword',['赵'])` → 返回 1 被引用 → 表格只剩赵六
- [x] 6.4 端到端（手测）：页面点行 → `selection-change` emit → agent 收到并能引用 — **已通过（2026-09-07）**：实测用搜索框触发 `emit('search', '王')`（UserList 现有事件），agent 下一轮准确复述「search 事件，关键词『王』」；`selection-change` 未做（el-table 需加多选列，与 emit 通知面无关）

## 7. 文档

- [ ] 7.1 `docs/agent-session.md`：协议表补 `call_page_method`（ServerMessage.tool.call 透传）、`page.emit`、`page.exposed`；`PageObservation` 联合新增 `page.emit`；session 模型补 `pageExposedKeys: Record<tag, string[]>`
- [ ] 7.2 `PROJECT.md`：§6「关键技术设计」补「三面表」expose/emit 现状；§7「演化路线」批 4 之前补本变更依赖说明
- [ ] 7.3 `packages/protocol/README.md`、`packages/analyzer/README.md`：契约补 exposes/emits 字段
- [ ] 7.4 `TODO.md`：勾掉 D5/D6 等与本变更相关的条目；新增本变更一行（批 3.5 / 4.5）

## 8. 验证 & 发布

- [x] 8.1 `pnpm typecheck`（含新增联合类型）通过 — 2026-09-07：`pnpm -r typecheck` 8/8 包 Done（含 vue-tsc 的 demo-app/chat-client）
- [x] 8.2 `pnpm test`：`wc-runtime-core` / `wc-runtime-vue` / `analyzer` 单测全绿 — 70 + 12 + 6 全过；agent-server 9 过
- [x] 8.3 `openspec validate agent-wc-expose-and-emit --strict` 通过
- [x] 8.4 `pnpm build:libs` + `pnpm build:ce` 通过（build:libs 顺序已修正为 analyzer → vite-plugin-wc）
- [ ] 8.5 `.changeset/` 加 changeset（minor：protocol/vue/analyzer 加能力；agent-server/chat-client 加工具与转发）— **实施注记（2026-09-07）**：`wc-runtime-vue` 因修复 `getPageExposed` 读取路径（Vue3.5 `_instance.exposed`）有行为变更；`build:libs` 顺序调整（analyzer→vite-plugin-wc）也随本变更。changeset 里 protocol/vue/analyzer 均建议 minor
- [ ] 8.6 存档：`openspec archive agent-wc-expose-and-emit`（任务全部 done 后）
