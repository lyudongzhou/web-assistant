// Markdown 气泡的结构验收：把**真实的一轮消息**灌进**真的组件**（构建产物），
// 断言「assistant 的结果气泡渲染成 Markdown 元素」「用户的话与关掉开关时仍是纯文本」。
//
// 为什么用 SSR 而不是单测 DOM：这里要证的是用户肉眼看到的那件事 —— 加粗是不是真的加粗了、
// 代码块是不是真的成了块、你打的 `**x**` 会不会被误渲染。没有浏览器时，SSR 输出的是同一套模板
// 的 HTML，足够验结构（与 `test/render-split.mjs` / `render-panel.mjs` 同一取舍）。
//
// 跑之前先构建：`pnpm --filter @webassistant/chat-client build:lib`（脚本读 dist）。
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { HostAssistantChat } from '../dist/index.js'

const checks = []
const check = (name, pass, extra = '') => {
  checks.push(pass)
  console.log(`${pass ? '✅' : '❌'} ${name}${extra ? ` —— ${extra}` : ''}`)
}

const render = (component, props) =>
  renderToString(createSSRApp({ render: () => h(component, props) }))

/** 一段典型的模型答复：列表 + 加粗 + 代码块 + 表格 + 链接 + 行内代码 */
const ANSWER = [
  '对比完成，结论如下：',
  '',
  '- **用户列表**：30 天内有 12 条新增',
  '- 数据源管理：口径一致',
  '',
  '```js',
  'const total = 12',
  '```',
  '',
  '| 页面 | 结论 |',
  '| --- | --- |',
  '| 用户列表 | 有差异 |',
  '',
  '详见 [数据源管理](https://example.com/ds)。',
].join('\n')

const bubble = (content, role = 'assistant') => [{ role, content, at: 1 }]

// 1) assistant 结果气泡：Markdown 真的成了元素
const md = await render(HostAssistantChat, { messages: bubble(ANSWER), loading: false })
check('assistant 气泡标了 md（块级排版由 CSS 接管）', md.includes('class="bubble md"'))
check('无序列表成了 <li>', md.includes('<ul>') && md.includes('<li>'))
check('加粗成了 <strong>（用户看到的不再是字面 ** **）', md.includes('<strong>用户列表</strong>'))
check('围栏代码块成了 <pre><code>', md.includes('<pre') && md.includes('<code class="language-js">'))
check('表格成了 <table>', md.includes('<table>') && md.includes('<th>页面</th>'))
check('链接带新窗口与 opener 断开', md.includes('target="_blank"') && md.includes('rel="noopener noreferrer"'))
check('关掉 md 时的字面残留为 0（`**` / 围栏 / 表格分隔行都不该留在页面上）',
  !md.includes('**用户列表**') && !md.includes('```') && !md.includes('| --- |'))

// 2) 用户气泡：md 样式不作用于用户自己的话（blue bubble 上是原话）
const user = await render(HostAssistantChat, {
  messages: [...bubble(ANSWER), ...bubble('把 **这个** 和 `那个` 都改成 #1', 'user')],
  loading: false,
})
const userSection = user.split('<div class="message user"')[1] ?? ''
check('同一屏里只有 assistant 那条走 md（用户气泡没有 md 类）',
  (user.match(/class="bubble md"/g)?.length ?? 0) === 1 && userSection.includes('class="bubble"'))
check('用户的话原样显示（`**这个**` 不被加粗、反引号不被吞）',
  userSection.includes('**这个**') && userSection.includes('`那个`') && !userSection.includes('<strong>'))

// 3) markdown:false：完整退回上 md 之前的行为（纯文本 + pre-wrap）
const plain = await render(HostAssistantChat, {
  messages: bubble(ANSWER),
  loading: false,
  markdown: false,
})
check('markdown=false 时保持字面文本（开关真的有用）',
  plain.includes('**用户列表**') && !plain.includes('<strong>') && !plain.includes('<pre>'))
check('markdown=false 时不标 md 类（`pre-wrap` 仍在，换行不丢）',
  !plain.includes('class="bubble md"') && plain.includes('class="bubble"'))

// 4) 不可信输入：模型输出里的 raw HTML 不会变成节点
const unsafe = await render(HostAssistantChat, {
  messages: bubble('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>'),
  loading: false,
})
check('raw HTML 被转义（气泡里不会冒出真节点）',
  !unsafe.includes('<img') && !unsafe.includes('<script>') && unsafe.includes('&lt;img'))

// 5) 过程区不受影响：思考 / 步骤仍按自己的排版（不走 md）
const trace = await render(HostAssistantChat, {
  messages: [
    ...bubble(ANSWER),
    { role: 'assistant', content: '我先看看 `user-list` 的 **口径**', kind: 'reasoning', at: 2 },
  ],
  loading: false,
  traceDefaultOpen: true,
})
check('思考块保持纯文本（反引号与星号不被渲染，过程区不是 md 面）',
  trace.includes('我先看看 `user-list` 的 **口径**') && !trace.includes('<strong>口径</strong>'))

console.log(`\n${checks.every(Boolean) ? '✅ 全部通过' : '❌ 有未通过项'}（${checks.filter(Boolean).length}/${checks.length}）`)
process.exit(checks.every(Boolean) ? 0 : 1)
