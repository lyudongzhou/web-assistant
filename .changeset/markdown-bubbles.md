---
"@webassistant/chat-client": minor
---

结果气泡按 Markdown 渲染（`markdown-it`），新增 `markdown` 开关

**改的问题**：结果气泡的正文事实上就是 Markdown —— 模型的自由文本（`chat.text{channel:'text'}`，
来自 Cline SDK 的 `assistant-text-delta`）在列表 / 对比 / 代码片段这类场景天然会写
`- 列表`、`**加粗**`、围栏代码；服务端下发的欢迎语里也有 `- 页面名（例如：…）`。
而在此之前一律按 `{{ content }}` + `white-space: pre-wrap` 显示 ⇒ 用户看到的是**字面的**
`**加粗**`、`- 列表`、``` 围栏，长答复的可读性明显差。

**为什么不做协议格式位**（本次刻意只改 chat-client）：`chat.text` 只有 `delta` + `channel`，
没有 `format` 字段 —— 客户端本来无从知道某一段是不是 Markdown。查过事实来源：prompt 里
**没有任何**输出格式要求（`manifest.service.ts` 全文 + 项目规则对 `markdown/格式/排版` 零命中），
所以「模型会写 Markdown」是"无保证但事实上成立"；服务端写死的那批文案（欢迎语 / 交接指引 /
进度交接 / 预算暂停）是纯中文、没有会被误判成结构的字符。于是选择**客户端一律宽松解析**，
并用 `breaks: true` 保证纯文本观感不回归（单换行仍是 `<br>`）—— 加协议字段只能换来"更确定"，
却要同时改 protocol + agent-server + chat-client 三个包。判据见 PROJECT.md §6.7.4。

**chat-client（minor）**

- 新增 `lib/markdown.ts`（纯逻辑、可单测）：`markdown-it` **单例**（`html:false` + `breaks:true` +
  `linkify:false`）+ `renderMarkdown(text)` / `getMarkdownRenderer()`。
  - 安全（agent 文本 = 模型输出，可能夹带页面数据 ⇒ 当不可信输入，**不需要**额外 sanitizer）：
    raw HTML 一律转义；`validateLink` 在解析期拒掉 `javascript:` / `vbscript:` / `file:`；
    **图片不产出 `<img>`**（否则 `![](https://third-party/?x=…)` 会把"谁在什么时候看"发给第三方）
    —— 只给「绝对 http(s)」的链接 + alt 文案；外链一律 `target="_blank" rel="noopener noreferrer"`；
    围栏代码块的语言标签只接受 `[\w+#.-]{1,20}` 的 info 串。
- 新增 `components/MarkdownText.vue`：`computed(() => renderMarkdown(text))` → `v-html`；
  Markdown 元素样式全部走 `:deep(...)`（scoped 样式作用不到 `v-html` 注入的节点 —— 写 `pre {}` 会静默不生效），
  字号用 `em`（两层渲染面的气泡字号不同：13px / 14px）；代码块与表格横向滚动，不撑破气泡。
- `ChatPanel` / `HostAssistantChat`：assistant 的**结果气泡**改走 `<MarkdownText>`，并加 `.bubble.md`
  （该路径 `white-space: normal`，块级排版交给 Markdown）；**用户气泡保持纯文本**（原话 + 蓝底配色），
  过程区 / 计划卡 / 问题卡 / 欢迎页一律不动（它们的排版是刻意设计的）。
- 新增 prop `markdown?: boolean`（缺省 `true`），`WebAssistant` / `HostAssistantDock` 透传；
  `WebAssistant` 显式给默认值 —— 与 `welcome` 同一个坑：Boolean prop 不给默认值时"不传"会被转成 `false`。
  关掉即为上 md 之前的行为（纯文本 + `pre-wrap`）。
- `index.ts` 导出 `MarkdownText` / `renderMarkdown` / `getMarkdownRenderer`（自写气泡可复用同一口径）；
  `WebAssistantThemeVars` 新增 `--wa-code-bg` / `--wa-code-text`。
- 依赖：`markdown-it@^15.0.2`（MIT；自带 ESM 与类型，打进预构建产物，宿主无需安装）——
  `THIRD_PARTY_NOTICES.md` 已登记。
- 验收：`test/markdown.test.mjs`（22 例）+ `test/render-markdown.mjs`（13 例，读 dist 的 SSR 结构验收，
  新增脚本 `test:render:markdown`）；既有 `render-split` / `render-panel` 与 115 个单测全绿。

**已知取舍**：`2 * 3 * 4` 这类文本可能被判成斜体（Markdown 的固有代价）；流式期间半截 Markdown
会有一次轻微跳动（ChatGPT / Claude 同款）；不做语法高亮，代码块"复制"按钮留作后续。
