## Context

`chat-client` 目前的对外 UI 只有一个「标准面板」`<WebAssistant>`（layout = header + ChatPanel + render-area +
ActivityLog），它是为**容器面**设计的：带渲染区、带 host-hint 提示条、三列布局。宿主直连面（用法 B）
要的是另一种形态 —— 窄悬浮窗、无渲染区、状态行 + 对话 + 动作时间线。

这套形态此前只活在 demo（`AssistantChat.vue` + `AssistantDock.vue`）。把它收进库要回答三个问题。

## Goals / Non-Goals

**Goals**

- 第三方**一个标签 + 一个 `createRuntime`** 就能得到 demo 里那种悬浮窗。
- UI 不引入 element-plus（第三方未必有），主题走既有 `--wa-*` token。
- 保留三层可定制性：整窗（dock props/插槽）→ 组件（chat / activities）→ headless（`useWebAssistant`）。
- demo 不再维护两份 UI 拷贝。

**Non-Goals**

- 不改容器面 `WebAssistant` / `ChatPanel` / `ActivityLog` 的 DOM 与样式（零回归）。
- 不在 chat-client 里 import vue-router（框架无关边界不变，`createRuntime` 仍由宿主注入）。
- 不把宿主侧私货（store 快照桥、调试句柄）搬进库 —— 用 `onRuntimeReady` 开口子。

## Decisions

### D1 组件放 chat-client，而 `createRuntime` 由宿主注入（边界不变）

dock 需要的是「造 runtime」这个动作，不是 router 本身。chat-client 继续不 import vue-router
（`types.ts:2-4` 的既有约定），宿主用 `createVueHostRuntimeBinding({ router, app, services })` 造好再传
`createRuntime`。代价是接入要写两行（binding + 标签），换来的是 chat-client 不绑定框架路由实现。

### D2 三个组件而不是一个（对话区与动作条独立导出）

`HostAssistantDock = 壳 + HostAssistantChat + HostAssistantActivities`。理由：
- 第三方的接入形态不一定是悬浮窗（可能想内嵌在自己的侧栏/抽屉里）→ `HostAssistantChat` 能单独用；
- 「本轮动作」是独立价值点 → 自写 UI 时也能单独挂；
- 每个文件都不大，且都遵循「数据进、事件出」，与既有 `ChatPanel` / `ActivityLog` 的分层一致。

### D3 不给容器面的 `ChatPanel` 加 prop 复用，而是新写对话区

差三点：没有标题栏、输入是多行 textarea + Enter/Shift+Enter + 流式「打断」、空态是**可点建议**。
若加 prop 复用，`ChatPanel` 会多出 4~5 个开关，而且容器面的 DOM/样式面临回归风险（文档承诺「逐字节不变」）。
两份组件的重叠只是「气泡 + 滚动」，不值得合并。

### D4 dock 的「收起」用 `v-show`（不销毁 runtime）

demo 已验证过的关键点：`v-if` 会把面板连同 runtime 一起卸载 → 收起期间 agent 导航不到宿主页面。
这条写进组件注释与文档（第 9.8 节），因为这正是「用了库组件的人容易踩」的地方。

### D5 空态建议缺省从页面目录推

`routes`（页面目录）本来就在 headless 层里。缺省建议 = `打开「${title ?? tag}」` 取前 3 个 ——
第三方不配任何文案也有一组**与它自己的页面**对齐的引导；要覆盖就传 `suggestions`，要关就传 `[]`。

### D6 头部的「清空对话」→「新会话」

旧 demo 调 `reset()`（只清本地消息，服务端 session 上下文还在，下一轮 prompt 里仍是旧页面/旧观察）。
库版本调 `startNewSession()`（清消息 + 断开重连 = 服务端新建会话），与容器面 `ChatPanel` 的「新会话」
语义一致。行为变化写在 changeset 里。

### D7 纯逻辑进 `lib/activities.ts`

「动作详情怎么截断 / 怎么占位 / 取最近几条」是展示口径，最容易被改样式时顺手改坏，也最值得单测。
与 `lib/welcome.ts` / `lib/initialPage.ts` / `lib/surface.ts` 同款：零依赖 + node:test 直测。

## Risks / Trade-offs

| 风险 | 缓解 |
|---|---|
| 库体积增长（含样式） | 实测 `dist/index.js` 354→366 kB、`dist/style.css` 12.7→20.8 kB —— 可接受；三个组件都是显式导入，未用到的会被 tree-shake |
| SFC 渲染无测试基建（仓库只有 node:test 直测纯逻辑） | 逻辑抽到 `lib/activities.ts` 单测覆盖；渲染由 demo 的 dev server 转译检查 + `pnpm --filter demo-app build` 整包构建兜底（诚实记录：不是渲染断言） |
| dock 与 `WebAssistant` 两套 UI 长期漂移 | 两者职责不同（渲染区 vs 无渲染区），且都消费同一份 `--wa-*` token 与同一份 headless 状态；文档明确各自的适用场景（§9.3 vs §9.8） |
| 第三方用 `v-if` 包 dock → 收起即卸载 | 组件注释 + §9.8 的「已知约定」小节明确写出 |

## Verification

1. `pnpm --filter @webassistant/chat-client test` → 31 条全绿（新增 7 条 activities 纯逻辑）。
2. `pnpm typecheck` 全绿（demo 已改用库组件，类型贯通即证明 props 契约可用）。
3. `pnpm --filter demo-app build` 通过（整包编译含新组件与 `--wa-*` 主题）。
4. dev server 转译检查：`/src/components/AssistantDock.vue` 200 且正确引用 `HostAssistantDock`。
5. `dist/index.d.ts` 含三个组件与 `HostAssistantDockProps`（第三方能拿到类型）。
6. 渲染表现（悬浮窗位置 / 视觉）需人工在浏览器确认 —— 本机浏览器自动化不可用（Chrome 占用 MCP profile）。
