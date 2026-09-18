## 1. 纯逻辑（packages/chat-client）

- [x] 1.1 `src/lib/activities.ts`：`ACTIVITY_DETAIL_CLIP` / `ACTIVITY_VISIBLE_LIMIT` /
      `formatActivityDetail`（args/result/error 分段 + 截断 + 占位） / `formatActivityTime` /
      `selectVisibleActivities` / `activityKey`
- [x] 1.2 `test/activities.test.mjs`：7 条（分段拼接 / 占位 / 截断 / 循环引用不抛 / 时间 / 取前 N / key 不撞）

## 2. 三个组件（packages/chat-client）

- [x] 2.1 `src/components/HostAssistantChat.vue`：对话区（无标题栏；多条 textarea + Enter/Shift+Enter；
      流式「打断」；可点建议；`#empty` 插槽；跟随滚动看**内容**变化）；原生 HTML + `--wa-*`，不用 element-plus
- [x] 2.2 `src/components/HostAssistantActivities.vue`：「本轮动作」折叠条（缺省收起；kind/name/ms/失败/时间；
      点开看详情；只渲染最近 40 条；`clear` 事件）
- [x] 2.3 `src/components/HostAssistantDock.vue`：悬浮壳（`v-show` 收起、`placement`）+ 头部
      （连接点/标题/徽标/返回/新会话/收起）+ 状态行（连接·导航来源·runtime·当前页 expose）+ `#status` 插槽 +
      错误横幅 + 组合上面两个组件；空态建议缺省从 `routes` 推导
- [x] 2.4 `src/types.ts`：`HostAssistantDockProps`（含用法示例注释）
- [x] 2.5 `src/index.ts`：导出三组件 + `HostAssistantDockProps` + `lib/activities.ts` 的纯逻辑

## 3. demo 收敛（packages/demo-app）

- [x] 3.1 `src/components/AssistantDock.vue` 重写为薄封装：`createVueHostRuntimeBinding` + store 快照桥 +
      `__waHostRuntime` 句柄 + demo 文案（保留 `onRuntimeReady` 作为扩展点示例）
- [x] 3.2 删除 `src/components/AssistantChat.vue`
- [x] 3.3 `src/styles/tokens.css`：补 `--wa-panel-bg` / `--wa-text-strong` / `--wa-text-muted` /
      `--wa-border-strong` / `--wa-border-light` / `--wa-radius*` / `--wa-error-*` 映射

## 4. 文档

- [x] 4.1 `docs/INTEGRATION_GUIDE.md`：新增 §9.8（开箱即用悬浮窗 + 定制对照表 + 两条已知约定）；
      §9.2 提示、§9.4 内的「自写窗口」措辞改为「库导出的悬浮窗」
- [x] 4.2 `PROJECT.md`：组件清单、§6.9 对照表「面板渲染区」行、接入段、坑表行
- [x] 4.3 `packages/demo-app/README.md`：两种用法的助手窗口对照表 + 说明
- [x] 4.4 `README.md`：包结构里 chat-client 一行补上悬浮窗
- [x] 4.5 changeset：`.changeset/export-host-assistant-dock.md`（chat-client minor）

## 5. 验证

- [x] 5.1 `pnpm --filter @webassistant/chat-client test` → 31 条全绿
- [x] 5.2 `pnpm typecheck` 全绿（demo 改用库组件后类型贯通）
- [x] 5.3 `pnpm --filter demo-app build` 通过
- [x] 5.4 dev server 转译检查：`/src/components/AssistantDock.vue` 200 且引用 `HostAssistantDock`
- [x] 5.5 `dist/index.d.ts` 含三组件与 `HostAssistantDockProps`
- [ ] 5.6 浏览器里的人工视觉确认（悬浮窗位置/配色/收起展开）—— 本机浏览器自动化不可用，留待人工
- [ ] 5.7 接 agent-server 点三条建议，确认「本轮动作」时间线按预期累积（需 `DEEPSEEK_API_KEY`）
