# export-host-assistant-dock

## Why

宿主直连（用法 B）的面板此前只存在于 demo 里：`packages/demo-app/src/components/AssistantChat.vue`
（对话区，300 行 UI）与 `AssistantDock.vue`（接线 + 悬浮壳，200 行）。第三方接入要用的正是这一套 ——
右下角悬浮窗、头部（连接态 / 返回 / 新会话 / 收起）、状态行（连接 / 导航来源 / runtime / 当前页 expose）、
「本轮动作」时间线 —— 却只能**从 demo 里抄**。

而它并不是 demo 专属的：

| 关注点 | 是否 demo 专属 | 证据 |
|---|---|---|
| 数据与事件形状 | 否 | 组件是纯「数据进（messages/activities/status/error）、事件出（send/cancel/back/collapse）」 |
| 主题 | 否（若改用 `--wa-*`） | 现状用 demo 的 `--app-*`；而 chat-client 的既有组件全用 `--wa-*` token |
| UI 库依赖 | 是（EP） | 用了 `el-button` / `el-input`，第三方项目未必有 element-plus |
| 文案与建议 | 是 | `SUGGESTIONS` / 空态文案写死为 demo 的业务 |
| store 快照桥 / 控制台句柄 | 是 | 宿主自己的 pinia 与调试习惯，必须留在宿主侧 |

结论：把「UI + 接线」收进 chat-client 导出，demo 退化成薄封装（演示 `onRuntimeReady` 这个扩展点）。

## What Changes

- **新导出三个组件**（`@webassistant/chat-client`）：
  - `HostAssistantDock` —— 拖动到布局外壳即可用的悬浮窗：接线（`useWebAssistant` + socket + runtime 初始化）
    + 壳（收起/展开、`placement`）+ 头部 + 状态行 + 对话 + 「本轮动作」。**只要一个 `createRuntime`**。
  - `HostAssistantChat` —— 对话区（多条 textarea + Enter/Shift+Enter + 流式「打断」+ 可点建议 + `#empty` 插槽）。
  - `HostAssistantActivities` —— 「本轮动作」折叠条（缺省收起：dock 空间宝贵）。
- **两种 UI 组件都不要 element-plus**：改用原生 `button` / `textarea`，样式全走 `--wa-*` token
  （与既有 `ChatPanel` / `ActivityLog` / `WelcomePage` 一致）→ 第三方不需要装 EP。
- **`tokens.css` 补齐 `--wa-*` 映射**（demo 侧）：`--wa-panel-bg` / `--wa-text-muted` / `--wa-border-*` /
  `--wa-radius*` / `--wa-error-*`，让「业务界面改一处，助手面板一起变」对 dock 也成立。
- **新纯逻辑模块 `lib/activities.ts`**（可单测）：`formatActivityDetail`（args/result/error 分段 + 截断）、
  `formatActivityTime`、`selectVisibleActivities`、`activityKey` + 两个上限常量 —— 自写 UI 也能复用同一展示口径。
- **demo 退化为薄封装**：`AssistantDock.vue` 只剩 binding + store 快照桥 + `__waHostRuntime` 句柄 + 文案；
  `AssistantChat.vue` 删除。
- **行为变化**：dock 头部的「清空对话」换成「**新会话**」（`startNewSession`：清消息 + 断开重连 = 服务端新建会话），
  与容器面 `ChatPanel` 的按钮语义一致（原来的 `reset` 只清本地消息，服务端上下文还在）。
- `HostAssistantDock` 的空态建议**缺省从页面目录推**（「打开『工作台』」×3）—— 第三方不配文案也有可点的引导。

## Capabilities

### New Capabilities

- `host-assistant-dock`: 宿主直连面的开箱即用面板 —— 库导出悬浮窗/对话区/动作时间线三个组件，
  宿主只提供 `createRuntime`；UI 不依赖任何第三方组件库，主题走 `--wa-*`；收起不销毁 runtime。

### Modified Capabilities

（无：既有 spec 目录为空，本变更只新增能力。）

## Impact

- `packages/chat-client`：新增 `components/HostAssistantDock.vue` / `HostAssistantChat.vue` /
  `HostAssistantActivities.vue` + `lib/activities.ts`；`types.ts` 新增 `HostAssistantDockProps`；
  `index.ts` 导出三组件 + 四组纯逻辑。
- `packages/demo-app`：`components/AssistantDock.vue` 重写为薄封装；删除 `components/AssistantChat.vue`；
  `styles/tokens.css` 补 `--wa-*` 映射。
- 测试：`packages/chat-client/test/activities.test.mjs`（7 条：截断 / 占位 / 循环引用 / 时间 / 截取上限 / key）。
- 文档：`docs/INTEGRATION_GUIDE.md` 新增 §9.8（开箱即用悬浮窗 + 定制对照表）；§9.2/§9.3 与
  `PROJECT.md` / `packages/demo-app/README.md` 中「自写窗口」的措辞改为「库导出的悬浮窗」。
- changeset：`@webassistant/chat-client`（minor）。
