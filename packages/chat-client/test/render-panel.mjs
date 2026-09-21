// 面板结构验收：计划卡的**折叠语义**（收起 = 一行）与「过程区 / 计划卡是同构的两个 panel」，
// 用真实组件（构建产物 dist）渲出的 HTML 断言。
//
// 为什么用 SSR 而不是单测 DOM：这里要证的是"用户肉眼看到的那件事"——收起来是不是只剩一行、
// 主操作按钮还在不在。没有浏览器时，SSR 输出的是同一套模板的 HTML，足够验结构
// （与 `test/render-split.mjs` 同一取舍）。
//
// 跑之前先构建：`pnpm --filter @webassistant/chat-client build:lib`（脚本读 dist）。
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { PlanCardView, TraceTimeline } from '../dist/index.js'

const checks = []
const check = (name, pass, extra = '') => {
  checks.push(pass)
  console.log(`${pass ? '✅' : '❌'} ${name}${extra ? ` —— ${extra}` : ''}`)
}

const render = (component, props) =>
  renderToString(createSSRApp({ render: () => h(component, props) }))

/** 计划卡的一轮（3 步、1 步已完成），`status` 由服务端权威下发 */
const planMessage = (status, extra = {}) => ({
  t: 'chat.plan',
  planId: 'plan-1',
  summary: '对比三张数据源的口径差异',
  createdAt: 1,
  status,
  revision: 1,
  steps: [
    { id: 'step-1', title: '打开数据源页', status: 'done' },
    { id: 'step-2', title: '逐个查看配置口径' },
    { id: 'step-3', title: '导出 CSV 对比' },
  ],
  ...extra,
})

/** 折叠头结构：`panel-head > panel-toggle > chev + …`（chevron 在最左） */
const HAS_SAME_HEAD = /<section class="panel[^"]*"[^>]*>\s*<div class="panel-head"[^>]*>\s*<button class="panel-toggle"[^>]*>\s*<span class="chev"/

const approved = await render(PlanCardView, {
  plan: { message: planMessage('approved'), status: 'approved' },
})
const proposed = await render(PlanCardView, {
  plan: { message: planMessage('proposed'), status: 'proposed' },
})
const revising = await render(PlanCardView, {
  plan: { message: planMessage('proposed'), status: 'proposed', draft: '第 3 步改成导出 CSV' },
})
const trace = await render(TraceTimeline, {
  items: [{ role: 'assistant', content: '正在打开页面', kind: 'step', at: 1, tool: 'render', target: 'data-source', settled: true, ok: true }],
})

// 1) 执行中：默认收起 = 只有折叠头一行（与过程区一样），动作条也收起
check(
  '执行中默认收起：折叠头是 ▸、没有详情区、没有动作条（折叠 = 一行）',
  /<span class="chev"[^>]*>▸<\/span>/.test(approved) &&
    !approved.includes('panel-body') &&
    !approved.includes('panel-footer'),
)
check(
  '执行中不渲染「开始执行 / 修改计划」（按钮随详情收起，要点开才出现）',
  !approved.includes('开始执行') && !approved.includes('修改计划'),
)
check(
  '收起后仍看得见"这是什么计划、做到哪了"（徽标 + 目标摘要 + 步骤计数）',
  approved.includes('计划执行中') &&
    approved.includes('对比三张数据源的口径差异') &&
    approved.includes('已完成 1/3'),
)

// 2) 待确认：默认展开（要用户做决定），步骤与主操作都在
check(
  '待确认默认展开：折叠头是 ▾、有详情区与步骤',
  /<span class="chev"[^>]*>▾<\/span>/.test(proposed) &&
    proposed.includes('panel-body') &&
    proposed.includes('导出 CSV 对比'),
)
check(
  '待确认渲染「开始执行 / 修改计划」（动作条在详情展开时可见）',
  proposed.includes('panel-body') &&
    proposed.includes('panel-footer') &&
    proposed.includes('开始执行') &&
    proposed.includes('修改计划'),
)

// 3) 修订输入态：提交前在卡内输入（输入框随详情展开）
check(
  '修改中：卡内输入框在详情里（草稿态 = 展开的输入视图）',
  revising.includes('revise-input') && revising.includes('提交修改') && revising.includes('取消'),
)

// 4) 同构：两处都是同一套壳（同一个 `.panel` + 同一个折叠头结构）
check(
  '两个 panel 同构：过程区与计划卡都是 `.panel` + `panel-head > panel-toggle > chev`',
  HAS_SAME_HEAD.test(trace) && HAS_SAME_HEAD.test(proposed),
)

// 5) 状态行（修订中提示 / 思考中…）不随折叠收起 —— 折起来也要看得见
const revisingFolded = await render(PlanCardView, {
  plan: { message: planMessage('proposed'), status: 'proposed', revising: true },
})
check(
  '修订中提示放在常驻状态行（收起时也可见）',
  /panel-status[^>]*>[\s\S]*?正在按你的意见更新计划/.test(revisingFolded),
)

console.log(`\n${checks.every(Boolean) ? '✅ 全部通过' : '❌ 有未通过项'}（${checks.filter(Boolean).length}/${checks.length}）`)
process.exit(checks.every(Boolean) ? 0 : 1)
