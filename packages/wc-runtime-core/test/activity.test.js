// activityBus 单测：这是「WC 执行监视」的存储层，注意它是全局单例（Symbol.for + globalThis），
// 所以每个用例开头先 clear + setLimit，避免互相污染。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activityBus,
  currentActivityOrigin,
  isActivityTraced,
  markActivityTraced,
  withActivityOrigin,
} from '../dist/index.js'

function reset() {
  activityBus.clear()
  activityBus.setLimit(200)
}

test('activityBus：report 自动补 at、最新在前、通知订阅者、退订生效', () => {
  reset()
  const seen = []
  const off = activityBus.on((a) => seen.push(a))

  const first = activityBus.report({ kind: 'navigate', tag: 'user-list', name: '/users' })
  const second = activityBus.report({ kind: 'emit', tag: 'user-list', name: 'search', args: { q: 'a' } })

  assert.equal(typeof first.at, 'number')
  assert.equal(second.name, 'search')
  assert.deepEqual(seen.map((a) => a.kind), ['navigate', 'emit'])
  assert.deepEqual(activityBus.snapshot().map((a) => a.kind), ['emit', 'navigate'], '最新在前')

  off()
  activityBus.report({ kind: 'error', name: 'boom' })
  assert.equal(seen.length, 2, '退订后不再收到')
  assert.equal(activityBus.snapshot().length, 3, '退订不影响落缓冲')
})

test('activityBus：环形缓冲按 limit 截断，setLimit 收紧立即生效', () => {
  reset()
  activityBus.setLimit(3)
  for (let i = 1; i <= 5; i += 1) activityBus.report({ kind: 'data', name: `s${i}` })
  assert.deepEqual(
    activityBus.snapshot().map((a) => a.name),
    ['s5', 's4', 's3'],
  )

  activityBus.setLimit(2)
  assert.equal(activityBus.limit, 2)
  assert.deepEqual(activityBus.snapshot().map((a) => a.name), ['s5', 's4'], '收紧后立即裁掉多余的')
})

test('activityBus：withActivityOrigin 同步区间生效、支持嵌套、退出后复位', () => {
  reset()
  assert.equal(currentActivityOrigin(), 'host', '缺省 host')

  const inside = withActivityOrigin('agent', () => {
    assert.equal(currentActivityOrigin(), 'agent')
    // 嵌套（agent 调页面 → 页面内又直调）不应提前复位
    return withActivityOrigin('host', () => currentActivityOrigin())
  })
  assert.equal(inside, 'host')
  assert.equal(currentActivityOrigin(), 'host', '退出后复位')

  // 抛错也要复位
  assert.throws(() =>
    withActivityOrigin('agent', () => {
      throw new Error('boom')
    }),
  )
  assert.equal(currentActivityOrigin(), 'host')
})

test('activityBus：args/result 脱敏 —— 深拷贝、环引用、超深截断', () => {
  reset()
  const circular = { name: 'a' }
  circular.self = circular
  const activity = activityBus.report({
    kind: 'call',
    name: 'save',
    args: [circular],
    // 层级 > MAX_VALUE_DEPTH(4) 的对象会被替换成 `[depth > 4]` 标记
    result: { l1: { l2: { l3: { l4: { l5: { l6: 'too deep' } } } } } },
  })

  assert.notEqual(activity.args[0], circular, '不保留原引用（深拷贝）')
  assert.equal(activity.args[0].self, '[circular]')
  assert.equal(activity.args[0].name, 'a')
  assert.match(JSON.stringify(activity.result), /depth > 4/, '超深对象被标记')
})

test('activityBus：listener 抛错不影响 report 与其它 listener', () => {
  reset()
  const seen = []
  const offBad = activityBus.on(() => {
    throw new Error('listener 炸了')
  })
  const offGood = activityBus.on((a) => seen.push(a))
  const warnings = []
  const originalWarn = console.warn
  console.warn = (msg) => warnings.push(String(msg))
  try {
    const activity = activityBus.report({ kind: 'error', name: 'x' })
    assert.equal(activity.kind, 'error')
  } finally {
    console.warn = originalWarn
    offBad()
    offGood()
  }
  assert.equal(seen.length, 1, '另一个 listener 照常收到')
  assert.equal(warnings.length, 1)
})

test('activityBus：markActivityTraced / isActivityTraced（宿主据此避免重复记账）', () => {
  reset()
  const plain = () => 1
  const traced = markActivityTraced(function tracedFn() {})
  assert.equal(isActivityTraced(plain), false)
  assert.equal(isActivityTraced(traced), true)
  assert.equal(typeof traced, 'function', 'markActivityTraced 原样返回对象')
})
