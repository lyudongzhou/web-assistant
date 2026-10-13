<template>
  <!-- 结果气泡的正文渲染：Markdown → HTML → `v-html`。
       为什么用 `v-html` 而不是 VNode：解析层是现成的 `markdown-it`（成熟、边界稳、非本项目的重点），
       它只产出 HTML 字符串。安全性不靠"别处的 sanitizer"，而靠渲染器的三条硬约束（见 lib/markdown.ts）：
       `html:false`（raw HTML 一律转义）、`validateLink`（`javascript:` 等在解析期被拒）、
       图片不产出 `<img>`（不自动请求第三方）。

       ⚠️ scoped 样式**作用不到** `v-html` 注入的节点（它们不带 `data-v-xxx`）—— 所以下面所有
       Markdown 元素的样式都必须走 `:deep(...)`；只写 `pre {}` 会静默不生效。 -->
  <div class="wa-markdown" v-html="html"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../lib/markdown.js'

const props = defineProps<{
  /** Markdown 源文本（气泡的 `content`） */
  text: string
}>()

// 跟着 `content` 变：流式期间每个 delta 都会重渲 —— 渲染器是单例、纯函数，代价可忽略
const html = computed(() => renderMarkdown(props.text))
</script>

<style scoped>
/* 字号一律用 em：两层渲染面的气泡字号不同（ChatPanel 14px / HostAssistantChat 13px），
   用 px 会让同一段 Markdown 在两条面上层级比例不一样。 */
.wa-markdown {
  line-height: 1.7;
  overflow-wrap: break-word;
}
/* 首尾元素不吃外边距：气泡本身已经有 padding + 圆角，多出来的 8px 会让气泡看起来是歪的 */
.wa-markdown :deep(> :first-child) {
  margin-top: 0;
}
.wa-markdown :deep(> :last-child) {
  margin-bottom: 0;
}

/* ── 段落与标题 ─────────────────────────────────────────── */
.wa-markdown :deep(p) {
  margin: 0 0 0.5em;
}
/* 层级刻意压得很窄（1.15 / 1.08 / 1 / 1em）：气泡是窄容器，标题只是"分段"，不该抢面板标题的注意力 */
.wa-markdown :deep(h1),
.wa-markdown :deep(h2),
.wa-markdown :deep(h3),
.wa-markdown :deep(h4),
.wa-markdown :deep(h5),
.wa-markdown :deep(h6) {
  margin: 0.7em 0 0.35em;
  font-weight: 600;
  line-height: 1.4;
}
.wa-markdown :deep(h1) {
  font-size: 1.15em;
}
.wa-markdown :deep(h2) {
  font-size: 1.08em;
}
.wa-markdown :deep(h3),
.wa-markdown :deep(h4),
.wa-markdown :deep(h5),
.wa-markdown :deep(h6) {
  font-size: 1em;
}
.wa-markdown :deep(strong) {
  font-weight: 600;
}
.wa-markdown :deep(hr) {
  margin: 0.7em 0;
  border: 0;
  border-top: 1px solid var(--wa-border, #e5e7eb);
}

/* ── 列表 ──────────────────────────────────────────────── */
.wa-markdown :deep(ul),
.wa-markdown :deep(ol) {
  margin: 0.35em 0;
  padding-left: 1.4em;
}
/* 嵌套列表由 markdown-it 产出的结构是 `li > ul`，内层不能再吃一份 0.35em 外边距 */
.wa-markdown :deep(li > ul),
.wa-markdown :deep(li > ol) {
  margin: 0.15em 0;
}
.wa-markdown :deep(li + li) {
  margin-top: 0.15em;
}

/* ── 引用 ──────────────────────────────────────────────── */
.wa-markdown :deep(blockquote) {
  margin: 0.5em 0;
  padding: 0.1em 0 0.1em 0.7em;
  border-left: 3px solid var(--wa-border, #e5e7eb);
  color: var(--wa-text-secondary, #6b7280);
}

/* ── 代码：行内与围栏 ───────────────────────────────────── */
.wa-markdown :deep(code) {
  padding: 0.1em 0.35em;
  border-radius: 4px;
  background: var(--wa-code-bg, rgba(17, 24, 39, 0.06));
  color: var(--wa-code-text, inherit);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
}
/* `position: relative` 给语言标签当锚点；`overflow-x: auto` = 长行横向滚动而不是撑破气泡 */
.wa-markdown :deep(pre) {
  position: relative;
  margin: 0.5em 0;
  padding: 0.6em 0.7em;
  max-width: 100%;
  border: 1px solid var(--wa-border-light, #f3f4f6);
  border-radius: var(--wa-radius-sm, 6px);
  background: var(--wa-code-bg, rgba(17, 24, 39, 0.06));
  overflow-x: auto;
}
.wa-markdown :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 0.92em;
  line-height: 1.6;
  white-space: pre;
  overflow-wrap: normal;
}
/* 语言标签（由 lib/markdown.ts 的 fence 规则插入）：绝对定位在顶部条带里 —— 不占代码行、不改文本。
   条带高度由下面 `pre.wa-md-has-lang` 的 `padding-top` 预留。 */
.wa-markdown :deep(pre.wa-md-has-lang) {
  /* 标签高 10px/1.6 ≈ 16px + 上下各 3px 呼吸 ⇒ 1.7em 在 12px 代码字号下约 20px */
  padding-top: 1.7em;
}
.wa-markdown :deep(.wa-md-lang) {
  position: absolute;
  top: 3px;
  right: 8px;
  color: var(--wa-text-muted, #9ca3af);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 1.6;
  pointer-events: none;
}

/* ── 表格：窄气泡里必须能横向滚（display:block + overflow），否则整屏被撑宽 ── */
.wa-markdown :deep(table) {
  display: block;
  max-width: 100%;
  margin: 0.5em 0;
  border-collapse: collapse;
  overflow-x: auto;
  font-size: 0.92em;
}
.wa-markdown :deep(th),
.wa-markdown :deep(td) {
  padding: 0.25em 0.5em;
  border: 1px solid var(--wa-border, #e5e7eb);
  text-align: left;
}
.wa-markdown :deep(thead th) {
  background: var(--wa-border-light, #f3f4f6);
  font-weight: 600;
}

/* ── 链接（一律新窗口打开；长链接要能在窄气泡里折行） ── */
.wa-markdown :deep(a) {
  color: var(--wa-primary, #3b82f6);
  text-decoration: underline;
  overflow-wrap: anywhere;
}
/* 兜底：即便未来放开了图片，也不让它撑破气泡 */
.wa-markdown :deep(img) {
  max-width: 100%;
}
</style>
