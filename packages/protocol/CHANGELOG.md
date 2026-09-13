# @webassistant/protocol

## 0.1.0

### Minor Changes

- 31df00c: **项目规则：`wc.pages.json` → `manifest.rules` → system prompt**（两级规则文档，改规则无需重启 agent-server）

  - **`analyzer`**：新增 `rules.ts`（`resolveRuleEntries`）—— 把 `wc.pages.json` 的 `rules` 声明
    （文件路径 / 目录（自动收集 `.md`、按文件名排序）/ 内联 `{ name, content }`，支持 frontmatter
    `name` / `disabled`，字段对齐 Cline SDK 的 `RuleConfig`）解析成 `ManifestRule[]`；
    **analyzer 与 `vite-plugin-wc` 共用同一实现**，避免两条生成路径漂移。
  - **`protocol`**：新增 `ManifestRule` 与 `manifest.rules` / `pages[].rules` 字段、`wcPages` 的 `rules` 声明类型。
  - **`vite-plugin-wc`**：manifest 增量生成接入 rules —— 指纹变化即重算；未声明但旧 manifest 有 `rules` →
    保留旧值（与 `dataSources` 同款「手工字段保留」，页面级同样适用）；dev watch 把规则文件/目录纳入监听，
    改动即增量重生成。
  - **agent-server**（不在 changeset）：`ManifestService.getRules()` + `buildAgentContext()` 把 manifest 级规则
    拼进 system prompt 的「项目规则」段（**优先于通用规则**）、页面级规则拼在「可用页面」列表里对应页面条目下
    （跳过 `disabled`）；本地 manifest 走 mtime 热重载、远程走定期刷新。

- 31df00c: **欢迎页 = 渲染区空态**（runtime 没有渲染子 WC 时渲染区的默认内容）：逻辑对外开放，宿主可整体覆盖。

  - **`wc-runtime-core`**：新增 `Runtime.hasPage`（有当前页 ⇔ 已渲染出子 WC，与 `RuntimeView.tag` 同源；
    `false` 时宿主应展示空态）。`initial: null` 不导航 → 天然 `false`，不再需要宿主自己记「导航过没有」。
  - **`chat-client`**：欢迎页拆三层并全部导出 ——
    - `lib/welcome.ts`（纯逻辑、零依赖、可单测）：`DEFAULT_WELCOME_TEXT`、`resolveWelcomeVariant`
      （`page` / `welcome-loading` / `welcome`）、`resolveWelcomeLoading`、`resolveWelcomeText`、
      `resolveWelcomeCapabilities`（握手载荷优先，本地 manifest 路由兜底）、`resolveWelcomeComponent`。
    - `composables/useWelcomePage.ts`：包成 `{ variant, visible, text, capabilities, loading }`；
      `useWebAssistant()` 以 `welcomePage` 透出（原先 headless 宿主只能自己再抄一遍判空与合并）。
    - `components/WelcomePage.vue`：默认呈现组件（`text` / `capabilities` / `loading`）。
  - **判空改用 runtime 事实**：`useRuntimeHost` 订阅 `view` 事件派生 `currentTag` / `hasPage`，不再用
    `navigate` 事件的粘性布尔（后者只表示「发生过导航」，加载失败不回退，且一旦导航过就再也回不到空态）。
  - **错误与欢迎页解耦**：错误独立成横幅（新增 `--wa-error-*` 主题变量），不再把空态整块替换成一行错误文本；
    有页面时错误也不再不可见。
  - **`loading` 语义修正**：由 `sessionReady` + `manifestSettled` 决定（**失败也算 settle**，不会死转圈），
    不再是「对话中」；刷新瞬间不会误显「暂无可操作页面」。
  - **修复「内置欢迎页永不渲染」**：`welcome` 的运行时 prop 含 `Boolean` 且无 `default` 时，Vue 会把缺省
    cast 成 `false`（runtime-core：`isAbsent && !hasDefault → value = false`）→ 被误判成「宿主关闭了欢迎页」，
    渲染区只剩最小空态。修法：`withDefaults` 显式 `welcome: undefined`（产物核对 `default: void 0`），
    并新增 `resolveWelcomeComponent` 兜住非组件值（`true` / 空串 → 回退内置组件）。
  - **覆盖优先级不变**：`#welcome` 插槽 > `welcome` prop > 内置 `WelcomePage` > `welcome=false` 最小空态；
    `#welcome` 插槽入参升级为**合并后的完整状态**（`WelcomePageSlotProps`）。
  - **`protocol`**：`session.ready.welcome = { text, capabilities[] }`（`WelcomePayload` / `WelcomeCapability`），
    随握手一并下发，供欢迎页渲染能力卡片；缺失时客户端用本地 manifest 路由兜底。
  - **首屏默认不自动打开页面**：`initialPage`（`boolean | string`）显式化；缺省 = 欢迎页先出现。
