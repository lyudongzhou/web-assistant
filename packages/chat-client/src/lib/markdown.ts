// 气泡里的 Markdown 渲染（纯逻辑，可单测）。
//
// 为什么要有这一层：
//   1. 结果气泡的正文只有两个来源 —— 模型的自由文本（Cline SDK 的 `assistant-text-delta`）与
//      服务端写死的文案（欢迎语 / 交接指引 / 进度交接）。前者事实上就是 Markdown（列表 / 加粗 /
//      代码块 / 表格），而上 md 之前一律按 `white-space: pre-wrap` 显示 —— 用户看到的是字面的
//      `**加粗**` 与 `- 列表`。prompt 里并没有任何输出格式要求，所以这是「事实上会，但不保证」。
//   2. 协议里 `chat.text` **没有格式字段**（只有 `delta` + `channel`）：「这一段是不是 Markdown」
//      客户端无从得知。因此这里按**宽松解析**处理：一律按 Markdown 渲染，并用 `breaks: true`
//      保住纯文本的观感（单换行仍是 `<br>`）。服务端那批文案里没有会被误判成结构的字符
//      （欢迎语的 `- 页面名（例如：…）` 本来就是个列表），两者渲染结果视觉等价 —— 这也是
//      本次**不给协议加 `format` 字段**的依据（见 PROJECT.md §6.8 的取舍说明）。
//
// 安全取舍（agent 文本 = 模型输出，可能夹带页面数据 ⇒ 一律视为不可信输入）：
//   - `html: false`：raw HTML 一律当文本转义（与上 md 之前的显示一致，也是最省事的白名单）。
//   - `linkify: false`：不把裸 URL 自动变成链接（少一处能点错的地方）。
//   - `validateLink` 保持默认：`javascript:` / `vbscript:` / `file:` 这类协议在**解析期**就被拒
//     （那一段退化成字面文本），所以链接不需要再叠一层 sanitizer。
//   - **图片不输出 `<img>`**：`![](https://third-party/probe?x=…)` 会让页面把「谁在什么时候看」
//     直接发给第三方。降级成一条「图片」链接：可见、可点，但不会自动发请求。
//
// 作用范围：**只给结果气泡**（`kind` 缺省 / `'message'`）。过程区（思考 / 步骤 / 错误）、计划卡、
// 问题卡、欢迎页的排版都是刻意设计的，不走这里。
import MarkdownIt from 'markdown-it'
// `markdown-it` 的默认导出是**可调用的类**（`MarkdownItCallable`），实例类型是同名的具名类型导出 ——
// 两者必须分开引，否则 `MarkdownIt` 会被当成值用（TS2749）。
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it'

/** 围栏代码块的语言标签：只认「像个语言名」的串，避免把模型的任意文本当标签往 DOM 里塞 */
const LANG_PATTERN = /^[\w+#.-]{1,20}$/

/** 图片降级成链接时允许的地址：只有绝对 http(s) 才给链接，其余只留 alt 文本 */
const IMAGE_HREF_PATTERN = /^(?:https?:)?\/\/[^\s<>"'`]+$/i

/**
 * 单例渲染器（构建一次，避免每条消息都重新装规则）。
 *
 * 为什么是单例而不是每次 new：MarkdownIt 的实例化会构建 core / block / inline 三套规则表，
 * 而结果气泡是**逐字流式重渲**的（`computed` 跟着 `content` 变），每次 new 是纯浪费。
 * 渲染器本身无状态（`render(text)` 不写实例字段），可以安全共享。
 */
let renderer: MarkdownItInstance | null = null

/** 取共享的 Markdown 渲染器（宿主想自己挂插件时用；不要改它的 rules 顺序之外的东西） */
export function getMarkdownRenderer(): MarkdownItInstance {
  if (renderer) return renderer

  const md = new MarkdownIt({
    html: false,
    // ★ 保住纯文本观感的关键：不写 `breaks` 的话，服务端那些「一行一句」的文案会塌成一整段。
    //   开了之后单换行即 `<br>`，与上 md 之前的 `white-space: pre-wrap` 表现一致。
    breaks: true,
    linkify: false,
  })

  // 外链一律新窗口打开 + 断开 opener（`href` 的安全性由 markdown-it 解析期的 validateLink 兜住）
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
    return self.renderToken(tokens, idx, options)
  }

  // 图片：不产出 `<img>`（不自动请求第三方），降级成「图片」链接或纯文案
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx]
    // `attrGet` 的类型是 `string | number | null`（markdown-it 允许数字属性值）⇒ 显式转成字符串
    const src = String(token.attrGet('src') ?? '')
    const alt = md.utils.escapeHtml(token.content ?? '')
    if (!IMAGE_HREF_PATTERN.test(src)) return alt
    const href = md.utils.escapeHtml(src)
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">【图片】${alt}</a>`
  }

  // 围栏代码块右上角挂语言标签。
  // 用默认渲染器产出的 HTML（保证转义 / highlight 语义与库一致），只在最前面插一个装饰性 span，
  // 并给 `pre` 加一个类名 —— 那条 CSS 会为标签**预留顶部条带**（`padding-top`），
  // 否则标签会压在第一行代码上（窄气泡里代码行基本都长于容器宽）。
  const defaultFence = md.renderer.rules.fence
  if (defaultFence) {
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const html = defaultFence(tokens, idx, options, env, self)
      const info = (tokens[idx].info ?? '').trim().split(/\s+/)[0] ?? ''
      if (!LANG_PATTERN.test(info)) return html
      return html.replace(
        /^<pre>/,
        `<pre class="wa-md-has-lang"><span class="wa-md-lang">${md.utils.escapeHtml(info)}</span>`,
      )
    }
  }

  renderer = md
  return md
}

/**
 * 一段 Markdown → HTML 字符串（供 `<MarkdownText>` 用 `v-html` 注入 / 宿主自写 UI 复用）。
 *
 * 空串、非字符串一律返回 `''`（气泡的 `content` 理论上是 string，但流式拼接与宿主自造消息都可能给空）。
 * 渲染结果是**安全的**：raw HTML 被转义、链接协议在解析期白名单化、图片不产出 `<img>`。
 */
export function renderMarkdown(text: string | null | undefined): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  return getMarkdownRenderer().render(text)
}
