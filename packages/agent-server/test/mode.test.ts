// mode 单测（node:test + tsx 直跑 src）。
// 覆盖：三层判定的边界（显式优先 / 多步信号 / 跨页 / 单页直做 / 判不了就交给模型），
// 以及"宁可漏判也不误判"的取舍（简单请求不许被拆成计划）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  heuristicMode,
  candidatePages,
  matchMultiStepSignal,
  matchPages,
  normalizeMode,
  resolveDefaultMode,
  resolveMode,
  type ModePageHint,
} from '../src/agent/mode.js'

const PAGES: ModePageHint[] = [
  { tag: 'user-list', title: '用户列表', keywords: ['用户', '名单'], requiredParamCount: 0 },
  { tag: 'user-detail', title: '用户详情', keywords: ['用户'], requiredParamCount: 1 },
  { tag: 'order-list', title: '订单列表', keywords: ['订单'], requiredParamCount: 0 },
  { tag: 'datasources', title: '数据源', keywords: ['数据源'], requiredParamCount: 0 },
]

test('显式模式优先：act / plan 直接采用，不再做任何猜测', () => {
  const plan = resolveMode({ requested: 'plan', text: '打开用户列表', pages: PAGES })
  assert.deepEqual(plan, {
    requested: 'plan',
    effective: 'plan',
    decidedBy: 'user',
    reason: '按你的选择',
  })
  // 哪怕是明显的多步描述，显式 act 也不改判
  const act = resolveMode({ requested: 'act', text: '先打开用户列表然后逐个查看数据源', pages: PAGES })
  assert.equal(act.effective, 'act')
  assert.equal(act.decidedBy, 'user')
})

test('auto + 多步信号 → plan（heuristic）', () => {
  const decision = resolveMode({
    requested: 'auto',
    text: '先看订单列表，然后把数据源逐个对比，最后出一份结论',
    pages: PAGES,
  })
  assert.equal(decision.effective, 'plan')
  assert.equal(decision.decidedBy, 'heuristic')
  assert.match(decision.reason ?? '', /多步/)
})

test('auto + 提到多个页面 → plan（heuristic）', () => {
  const decision = resolveMode({ requested: 'auto', text: '看看用户列表和订单列表的差异', pages: PAGES })
  assert.equal(decision.effective, 'plan')
  assert.equal(decision.decidedBy, 'heuristic')
})

test('auto + 单个明确页面且无必填参数 → act（heuristic）', () => {
  const decision = resolveMode({ requested: 'auto', text: '打开用户列表', pages: PAGES })
  assert.equal(decision.effective, 'act')
  assert.equal(decision.decidedBy, 'heuristic')
})

test('auto + 单页但缺必填参数 → 交给模型（model）', () => {
  // user-detail 需要 id：不能直接判"单页直做"，但也不该武断判成计划
  const decision = resolveMode({ requested: 'auto', text: '看看用户详情', pages: PAGES })
  assert.equal(decision.effective, 'plan')
  assert.equal(decision.decidedBy, 'model')
})

test('auto + 判不了 → 计划倾向 + model（模型自选）', () => {
  const decision = resolveMode({ requested: 'auto', text: '帮我处理一下这个事情', pages: PAGES })
  assert.equal(decision.effective, 'plan')
  assert.equal(decision.decidedBy, 'model')
  assert.match(decision.reason ?? '', /无法判定/)
})

test('会话模式被沿用：请求缺省时用 sessionMode', () => {
  const decision = resolveMode({ sessionMode: 'act', text: '先做 A 再做 B', pages: PAGES })
  assert.equal(decision.requested, 'act')
  assert.equal(decision.effective, 'act')
  assert.equal(decision.decidedBy, 'user')
})

test('默认模式：缺省 auto，非法值回落 auto', () => {
  assert.equal(resolveDefaultMode(undefined), 'auto')
  assert.equal(resolveDefaultMode('plan'), 'plan')
  assert.equal(resolveDefaultMode('act'), 'act')
  assert.equal(resolveDefaultMode('yolo'), 'auto')
  assert.equal(normalizeMode('yolo'), undefined)
})

test('启发式是保守的：没有多步信号时不会把简单请求拆成计划', () => {
  assert.equal(heuristicMode({ text: '打开订单列表', pages: PAGES })?.effective, 'act')
  // 空输入判不了
  assert.equal(heuristicMode({ text: '   ', pages: PAGES }), undefined)
})

test('matchMultiStepSignal / matchPages：命中即可观测', () => {
  assert.equal(matchMultiStepSignal('先看 A 再看 B'), '先看 A 再')
  assert.equal(matchMultiStepSignal('打开用户列表'), undefined)
  assert.deepEqual(
    matchPages('用户和订单', PAGES).map((page) => page.tag),
    ['user-list', 'user-detail', 'order-list'],
  )
  assert.deepEqual(matchPages('完全无关的话', PAGES), [])
})

test('页面命中分层：title 命中压过别页的关键词命中（避免简单请求被误判成跨页）', () => {
  // 「用户列表」同时命中 user-list 的 title(2) 与 user-detail 的 keyword「用户」(1)
  assert.deepEqual(candidatePages('打开用户列表', PAGES).map((page) => page.tag), ['user-list'])
  // tag 命中（3）优先于一切
  assert.deepEqual(candidatePages('打开 user-list', PAGES).map((page) => page.tag), ['user-list'])
  // 同级并列才算"跨页"
  assert.deepEqual(
    candidatePages('用户列表和订单列表', PAGES).map((page) => page.tag),
    ['user-list', 'order-list'],
  )
})
