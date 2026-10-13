// lib/markdown.ts 单测：结果气泡的 Markdown 渲染（纯逻辑，不拉起 vue）。
//
// 这个文件锁住三件事：
//   ① **观感不回归** —— `breaks: true` 让单换行仍是 `<br>`（上 md 之前靠 `white-space: pre-wrap`）；
//   ② **流式中途不难看也不炸** —— 未闭合的围栏 / 未闭合的强调符都要有确定结果；
//   ③ **模型输出当不可信输入** —— raw HTML 转义、`javascript:` 链接被拒、图片不产出 `<img>`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getMarkdownRenderer, renderMarkdown } from '../src/lib/markdown.ts'

// ── ① 段落与换行（纯文本观感不回归） ──────────────────────────────────────

test('单换行仍是 <br>（breaks:true —— 服务端那些「一行一句」的文案不会塌成一整段）', () => {
  const html = renderMarkdown('你好，我是本站的智能助手 👋\n我可以理解你的需求，直接帮你打开并操作对应的页面。')
  assert.match(html, /智能助手 👋<br>\n我可以理解你的需求/)
})

test('空行分段、段内中文与 emoji 原样保留', () => {
  const html = renderMarkdown('第一段\n\n第二段')
  assert.deepEqual(html.match(/<p>/g)?.length, 2)
  assert.ok(!html.includes('<br>'), '空行是分段，不是换行')
})

test('空串 / 非字符串一律返回空串（宿主自造消息与流式首帧都可能给空）', () => {
  assert.equal(renderMarkdown(''), '')
  assert.equal(renderMarkdown(null), '')
  assert.equal(renderMarkdown(undefined), '')
})

// ── 块级：标题 / 列表 / 引用 / 分割线 / 代码块 / 表格 ──────────────────────

test('标题与分割线', () => {
  const html = renderMarkdown('# 一\n\n## 二\n\n---')
  assert.ok(html.includes('<h1>一</h1>'))
  assert.ok(html.includes('<h2>二</h2>'))
  assert.ok(html.includes('<hr>'))
})

test('无序 / 有序 / 嵌套列表', () => {
  const html = renderMarkdown('- 打开用户列表\n  - 输入关键词\n- 查看详情\n\n1. 第一步\n2. 第二步')
  assert.ok(html.includes('<ul>') && html.includes('<ol>'))
  assert.match(html, /打开用户列表\n<ul>/, '嵌套列表是 li > ul')
  assert.ok(html.includes('<li>第一步</li>'))
})

test('引用块', () => {
  const html = renderMarkdown('> 这句是引用')
  assert.ok(html.includes('<blockquote>') && html.includes('这句是引用'))
})

test('围栏代码块：带语言标签、内容原样（不被当 Markdown 解析）', () => {
  const html = renderMarkdown('```js\nconst a = [1, 2]\n// *不是斜体*\n```')
  assert.ok(html.includes('<pre class="wa-md-has-lang">'), '有语言标签时给 pre 加类名（CSS 据此预留条带）')
  assert.ok(html.includes('<code class="language-js">'))
  assert.ok(html.includes('const a = [1, 2]'))
  assert.ok(html.includes('// *不是斜体*'), '代码块里的一律是字面文本')
  assert.ok(html.includes('<span class="wa-md-lang">js</span>'), '语言标签只接受「像语言名」的串')
})

test('围栏代码块：没有语言 / 语言名不像话时都不挂标签', () => {
  const plain = renderMarkdown('```\nplain\n```')
  assert.ok(!plain.includes('wa-md-lang'))
  assert.ok(plain.includes('<pre>'), '没有标签时不加类名（不多吃 padding）')
  // info 里塞 HTML 也进不了 DOM（标签正则只认 [\w+#.-]，其余一律不挂）
  const injected = renderMarkdown('```js"><img src=x onerror=alert(1)\ncode\n```')
  assert.ok(!injected.includes('wa-md-lang'))
  assert.ok(!injected.includes('<img'))
})

test('代码块里的 HTML 也保持转义（不产出真节点）', () => {
  const html = renderMarkdown('```html\n<script>alert(1)</script>\n```')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('表格：表头 / 对齐 / 单元格', () => {
  const html = renderMarkdown('| 页面 | 口径 |\n| --- | ---: |\n| 用户列表 | 30 天 |')
  assert.ok(html.includes('<table>') && html.includes('<thead>'))
  assert.ok(html.includes('style="text-align:right"'))
  assert.ok(html.includes('<td>用户列表</td>'))
})

// ── 行内：代码 / 强调 / 链接 ─────────────────────────────────────────────

test('行内代码、粗体、斜体、删除线', () => {
  const html = renderMarkdown('用 `call_page_method` **精准**操作，*别* ~~别~~ 乱点')
  assert.ok(html.includes('<code>call_page_method</code>'))
  assert.ok(html.includes('<strong>精准</strong>'))
  assert.ok(html.includes('<em>别</em>'))
  assert.ok(html.includes('<s>别</s>'))
})

test('链接：新窗口打开 + 断开 opener', () => {
  const html = renderMarkdown('[数据源管理](https://example.com/ds?tab=1)')
  assert.ok(html.includes('href="https://example.com/ds?tab=1"'))
  assert.ok(html.includes('target="_blank"'))
  assert.ok(html.includes('rel="noopener noreferrer"'))
})

// ── ③ 不可信输入：raw HTML / 危险协议 / 外链图片 ─────────────────────────

test('raw HTML 一律转义（`html:false`，与上 md 之前的显示一致）', () => {
  const html = renderMarkdown('<script>alert(1)</script>')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))

  const img = renderMarkdown('<img src=x onerror=alert(1)>')
  assert.ok(!img.includes('<img'))
  assert.ok(img.includes('&lt;img'))
})

test('危险协议的链接在解析期就被拒（退化成字面文本，不产出 href）', () => {
  for (const source of ['[点我](javascript:alert(1))', '[点我](vbscript:msgbox(1))']) {
    const html = renderMarkdown(source)
    assert.ok(!html.includes('href='), `${source} 不该产出链接`)
    assert.ok(html.includes('点我'))
  }
})

test('图片降级成链接：不产出 <img>（不自动请求第三方），绝对 http(s) 才给链接', () => {
  const external = renderMarkdown('![架构图](https://example.com/a.png)')
  assert.ok(!external.includes('<img'))
  assert.ok(external.includes('【图片】架构图'))
  assert.ok(external.includes('href="https://example.com/a.png"'))

  for (const source of ['![x](data:image/png;base64,AAAA)', '![x](javascript:alert(1))']) {
    const html = renderMarkdown(source)
    assert.ok(!html.includes('<img'), `${source} 不该产出 img`)
    assert.ok(!html.includes('href='), `${source} 不该产出链接`)
    assert.ok(html.includes('x'), 'alt 文本要留下')
  }
})

// ── ② 流式中途（逐字追加时的中间态） ──────────────────────────────────────

test('流式中途：未闭合的围栏仍是代码块，且不吞掉前面的正文', () => {
  const html = renderMarkdown('好的，代码如下：\n\n```js\nconst a = 1')
  assert.match(html, /<p>好的，代码如下：<\/p>/)
  assert.ok(html.includes('<pre') && html.includes('const a = 1'))
})

test('流式中途：未闭合的强调符号按字面输出（不半渲染成样式）', () => {
  const html = renderMarkdown('这是 **没闭合的加粗')
  assert.ok(html.includes('**没闭合的加粗'))
  assert.ok(!html.includes('<strong>'))
})

test('流式中途：半截链接 / 半截表格不抛错', () => {
  assert.doesNotThrow(() => renderMarkdown('看 [这里](https://exa'))
  assert.doesNotThrow(() => renderMarkdown('| a | b |\n| --- |'))
})

// ── 服务端文案的真实形状（宽松解析的依据） ────────────────────────────────

test('服务端欢迎语（真实形状）渲染成段落 + 列表，正文一句不少', () => {
  const text = [
    '你好，我是本站的智能助手 👋',
    '我可以理解你的需求，直接帮你打开并操作对应的页面。',
    '',
    '目前我能帮你：',
    '- 数据源管理（例如：看看有哪些数据源）',
    '- 用户列表（例如：列出所有用户）',
    '',
    '直接说出你想做什么就可以了。',
  ].join('\n')
  const html = renderMarkdown(text)
  assert.ok(html.includes('<ul>') && html.includes('<li>数据源管理（例如：看看有哪些数据源）</li>'))
  assert.ok(html.includes('直接说出你想做什么就可以了。'))
  assert.ok(html.includes('我可以理解你的需求，直接帮你打开并操作对应的页面。'), '一句都不能丢')
})

// ── 复用与规模 ───────────────────────────────────────────────────────────

test('渲染器是单例（流式期间每个 delta 重渲，不该每次重建规则表）', () => {
  assert.equal(getMarkdownRenderer(), getMarkdownRenderer())
})

test('大文本（约 20KB）+ 重复渲染不退化（防灾难性回溯的护栏，阈值给得很宽）', () => {
  const block = '## 小节\n\n- 要点一\n- 要点二 `code`\n\n```js\nconst a = 1\n```\n\n'
  const text = `${block}\n\n`.repeat(200)
  assert.ok(text.length > 10_000, `样本 ${text.length} 字符，要够大才叫规模验收`)
  const started = Date.now()
  for (let i = 0; i < 10; i += 1) assert.ok(renderMarkdown(text).length > 0)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5_000, `10 次渲染耗时 ${elapsed}ms，超出护栏`)
})

test('幂等：同一段文本两次渲染结果一致（无隐藏状态）', () => {
  const text = '**a**\n\n- b\n\n```js\nc\n```'
  assert.equal(renderMarkdown(text), renderMarkdown(text))
})
