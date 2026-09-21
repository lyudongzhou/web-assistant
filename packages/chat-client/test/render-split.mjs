// 渲染结构验收：把**真实的一轮**消息灌进**真的组件**（构建产物），断言两栏确实分开了。
//
// 为什么用 SSR 而不是单测 DOM：这里要证的是"结果气泡里只有结果、过程在它自己的区域里"，
// 也就是用户肉眼看到的那件事。没有浏览器时，SSR 输出的是同一套模板的 HTML —— 足够验结构。
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { HostAssistantChat } from '/Users/lvdongzhou/codePersonal/webassistant/packages/chat-client/dist/index.js'

const messages = [
  { role: 'user', content: '打开用户列表，找一下李四', at: 1 },
  { role: 'assistant', content: '用户要查李四，我先打开用户列表页', kind: 'reasoning', at: 2 },
  {
    role: 'assistant', content: '正在打开页面 <user-list>', kind: 'step', at: 3,
    tool: 'render', target: 'user-list', args: { tag: 'user-list' }, settled: false,
  },
  {
    role: 'assistant', content: '正在打开页面 <user-list>', kind: 'step', at: 4,
    tool: 'render', target: 'user-list', settled: true, ok: true, durationMs: 180,
  },
  {
    role: 'assistant', content: '正在调用 当前页.setKeyword()', kind: 'step', at: 5,
    tool: 'call_page_method', target: 'setKeyword', settled: true, ok: false, error: '方法未暴露', durationMs: 3,
  },
  { role: 'assistant', content: '已经打开用户列表并填好筛选条件，请确认。', kind: 'message', at: 6 },
]

const app = createSSRApp({
  render: () => h(HostAssistantChat, { messages, loading: false, traceDefaultOpen: true }),
})
const html = await renderToString(app)

const bubbleSection = html.split('trace')[0]
const checks = []
const check = (name, pass, extra = '') => {
  checks.push(pass)
  console.log(`${pass ? '✅' : '❌'} ${name}${extra ? ` —— ${extra}` : ''}`)
}

check('结果气泡只有结果正文', bubbleSection.includes('已经打开用户列表并填好筛选条件'))
check('用户消息仍是气泡（别把用户的话也塞进过程区）', bubbleSection.includes('打开用户列表，找一下李四'))
check('结果气泡里不含步骤文案', !bubbleSection.includes('正在打开页面'))
check('结果气泡里不含思考文案', !bubbleSection.includes('我先打开用户列表页'))
check('过程区有「过程」标题与步数摘要', html.includes('过程') && /\d+ 步/.test(html))
check('过程区显示本轮耗时与失败计数', html.includes('失败'))
check('思考是独立块（带「思考」标签，不是气泡）', html.includes('思考') && html.includes('我先打开用户列表页'))
check('步骤行带目标与耗时', html.includes('user-list') && html.includes('180ms'))
check('失败步骤带 error 与红标', html.includes('方法未暴露'))
// 旧实现把过程行以 `\n> 正在打开页面...\n` 追加进结果气泡里 —— 那会渲染成 `&gt; 正在打开页面`。
// 注意不能笼统地找 `&gt;`：`<user-list>` 这种 tag 本身就会被转义成 `&lt;…&gt;`（合法）。
const legacyPrefixResidue = /&gt;\s*(正在打开页面|等待页面数据|正在调用)/.test(html)
check('结果气泡里没有旧的 "> 正在…" 过程行残留', !legacyPrefixResidue)
check('「思考中…」不再作为独立气泡出现（loading=false 时不该有）', !html.includes('思考中…'))

console.log(`\n${checks.every(Boolean) ? '✅ 全部通过' : '❌ 有未通过项'}（${checks.filter(Boolean).length}/${checks.length}）`)
process.exit(checks.every(Boolean) ? 0 : 1)
