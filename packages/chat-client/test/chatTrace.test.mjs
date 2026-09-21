// chatTrace 纯逻辑单测：过程/结果分流、流式游标按通道隔离、步骤 start→end 配对、
// 折叠标题摘要、agent 步骤与 runtime 活动的合并去重。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TRACE_MERGE_WINDOW_MS,
  appendStream,
  buildTraceRows,
  formatDuration,
  mergeTimeline,
  pushStep,
  splitMessages,
  summarizeTrace,
} from '../src/lib/chatTrace.ts'

const step = (overrides = {}) => ({
  t: 'agent.step',
  index: 1,
  text: '正在打开页面 <user-list>',
  phase: 'start',
  tool: 'render',
  target: 'user-list',
  ...overrides,
})

const call = (overrides = {}) => ({
  at: 1_000,
  kind: 'call',
  name: 'setKeyword',
  origin: 'agent',
  ok: true,
  ...overrides,
})

// ── 流式：结果与思考各自成条 ──────────────────────────────────────────────

test('流式：结果与思考是两个通道，游标互不串联', () => {
  const messages = []
  let text = appendStream(messages, -1, 'message', '好', 1)
  let reasoning = appendStream(messages, -1, 'reasoning', '先看', 2)
  text = appendStream(messages, text, 'message', '的', 3)
  reasoning = appendStream(messages, reasoning, 'reasoning', '一下', 4)

  assert.equal(messages.length, 2, '两条独立消息，不是拼在一起的一条')
  assert.deepEqual(messages.map((m) => m.kind), ['message', 'reasoning'])
  assert.equal(messages[0].content, '好的')
  assert.equal(messages[1].content, '先看一下')
})

test('流式：中间插了步骤后，下一段结果另起一条（多 iteration 交错）', () => {
  const messages = []
  appendStream(messages, -1, 'message', '先打开列表', 1)
  pushStep(messages, step(), 2)
  // chat.done 后重置游标 → 下一段文本另起一条，而不是续写步骤或凭空续接旧结果
  const cursor = appendStream(messages, -1, 'message', '找到了李四', 3)

  assert.equal(cursor, 2)
  assert.deepEqual(
    messages.map((m) => [m.kind ?? 'message', m.content]),
    [
      ['message', '先打开列表'],
      ['step', '正在打开页面 <user-list>'],
      ['message', '找到了李四'],
    ],
  )
})

test('流式：游标指向的若是别的通道 → 另起一条（不串行追加）', () => {
  const messages = []
  const cursor = appendStream(messages, -1, 'reasoning', '想', 1)
  const next = appendStream(messages, cursor, 'message', '答', 2)
  assert.equal(next, 1)
  assert.deepEqual(messages.map((m) => m.kind), ['reasoning', 'message'])
})

// ── 步骤：start → end 就地结算 ──────────────────────────────────────────

test('步骤：end 就地结算那一行，不新增（1 start + 1 end = 1 行）', () => {
  const messages = []
  pushStep(messages, step(), 100)
  pushStep(messages, step({ phase: 'end', ok: true, durationMs: 120 }), 220)

  assert.equal(messages.length, 1)
  assert.equal(messages[0].settled, true)
  assert.equal(messages[0].ok, true)
  assert.equal(messages[0].durationMs, 120)
})

test('步骤：start 时 settled=false（UI 显示进行中），end 后置 true', () => {
  const messages = []
  pushStep(messages, step(), 100)
  assert.equal(messages[0].settled, false)
  assert.equal(messages[0].ok, undefined, '还没结算就不该有成败')
})

test('步骤：失败带 error 且 ok=false', () => {
  const messages = []
  const text = '正在调用 当前页.setKeyword()'
  pushStep(messages, step({ text, tool: 'call_page_method', target: 'setKeyword' }), 100)
  pushStep(
    messages,
    step({
      text,
      phase: 'end',
      tool: 'call_page_method',
      target: 'setKeyword',
      ok: false,
      error: '方法未暴露',
    }),
    150,
  )
  assert.equal(messages[0].ok, false)
  assert.equal(messages[0].error, '方法未暴露')
  assert.equal(messages[0].content, text)
})

test('步骤：没有可配对的 start → 退化成一条已结算步骤（不丢信息）', () => {
  const messages = []
  pushStep(messages, step({ phase: 'end', ok: true, durationMs: 9 }), 100)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].settled, true)
  assert.equal(messages[0].durationMs, 9)
})

test('步骤：同工具不同 target 各自成条（两跳不会合成一行）', () => {
  const messages = []
  pushStep(messages, step({ target: 'user-list' }), 100)
  pushStep(messages, step({ target: 'user-detail' }), 200)
  pushStep(messages, step({ phase: 'end', target: 'user-list', ok: true, durationMs: 10 }), 250)

  assert.equal(messages.length, 2)
  assert.equal(messages[0].settled, true, '只结算 user-list 那一行')
  assert.equal(messages[1].settled, false, 'user-detail 仍在跑')
})

// ── 分流与摘要 ─────────────────────────────────────────────────────────

test('分流：kind 缺省的（老宿主自造消息）算结果气泡，不被藏进过程区', () => {
  const messages = [
    { role: 'assistant', content: '默认算结果' },
    { role: 'assistant', content: '结果', kind: 'message' },
    { role: 'assistant', content: '步骤', kind: 'step' },
    { role: 'assistant', content: '思考', kind: 'reasoning' },
    { role: 'assistant', content: '错误', kind: 'error' },
    { role: 'user', content: '用户说的' },
  ]
  const { bubbles, trace } = splitMessages(messages)
  assert.deepEqual(bubbles.map((m) => m.content), ['默认算结果', '结果', '用户说的'])
  assert.deepEqual(trace.map((m) => m.content), ['步骤', '思考', '错误'])
})

test('摘要：步数 / 进行中 / 失败 / 耗时', () => {
  const trace = [
    { role: 'assistant', content: 'a', kind: 'step', settled: true, ok: true, durationMs: 10 },
    { role: 'assistant', content: 'b', kind: 'step', settled: false },
    { role: 'assistant', content: 'c', kind: 'step', settled: true, ok: false, error: 'x' },
    { role: 'assistant', content: '想', kind: 'reasoning' },
  ]
  assert.deepEqual(summarizeTrace(trace, 8_200), {
    stepCount: 3,
    running: 1,
    failed: 1,
    durationMs: 8_200,
  })
  assert.equal(summarizeTrace(trace).durationMs, undefined, '没给耗时就不显示')
})

test('耗时展示：< 1s 用毫秒，否则用秒', () => {
  assert.equal(formatDuration(120), '120ms')
  assert.equal(formatDuration(8_200), '8.2s')
  assert.equal(formatDuration(1_000), '1.0s')
  assert.equal(formatDuration(Number.NaN), '—')
})

// ── 时间轴合并（去重）────────────────────────────────────────────────────

test('合并：call_page_method 的 step 与 origin=agent 的 call 活动合成一行', () => {
  const steps = [
    { role: 'assistant', content: '正在调用 当前页.setKeyword()', kind: 'step', at: 1_000, tool: 'call_page_method', target: 'setKeyword', settled: true, ok: true },
  ]
  const items = mergeTimeline(steps, [call({ at: 1_200, durationMs: 80, result: 12 })])
  assert.equal(items.length, 1, '同一步不出现两行')
  assert.equal(items[0].source, 'step')
  assert.equal(items[0].text, '正在调用 当前页.setKeyword()')
  assert.equal(items[0].durationMs, 80, '耗时取 activity 的真实区间')
  assert.equal(items[0].activity.result, 12, 'args/result 仍可展开看')
})

test('合并：origin=host 的 call 不与 agent 那一步配对（那是页面自己的调用）', () => {
  const steps = [
    { role: 'assistant', content: '正在调用 当前页.refresh()', kind: 'step', at: 1_000, tool: 'call_page_method', target: 'refresh', settled: false },
  ]
  const items = mergeTimeline(steps, [call({ at: 1_100, origin: 'host' })])
  assert.equal(items.length, 2, '配不上就都保留')
  assert.deepEqual(items.map((i) => i.source), ['step', 'activity'])
})

test('合并：超出时间窗的活动不配对', () => {
  const steps = [
    { role: 'assistant', content: '正在调用 当前页.setKeyword()', kind: 'step', at: 1_000, tool: 'call_page_method', target: 'setKeyword', settled: true, ok: true },
  ]
  const far = call({ at: 1_000 + TRACE_MERGE_WINDOW_MS + 1 })
  assert.equal(mergeTimeline(steps, [far]).length, 2)
  const near = call({ at: 1_000 + TRACE_MERGE_WINDOW_MS - 1 })
  assert.equal(mergeTimeline(steps, [near]).length, 1)
})

test('合并：render 的 step 与 navigate 活动配对', () => {
  const steps = [
    { role: 'assistant', content: '正在打开页面 <user-list>', kind: 'step', at: 1_000, tool: 'render', target: 'user-list', settled: true, ok: true },
  ]
  const items = mergeTimeline(steps, [{ at: 1_100, kind: 'navigate', name: '/users', durationMs: 30 }])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'render')
  assert.equal(items[0].durationMs, 30)
})

test('合并：wait_for_observation 不参与配对（没有对应的 runtime 活动）', () => {
  const steps = [
    { role: 'assistant', content: '正在等待页面数据', kind: 'step', at: 1_000, tool: 'wait_for_observation', settled: true, ok: true },
  ]
  const items = mergeTimeline(steps, [{ at: 1_100, kind: 'data', name: '/api/users' }])
  assert.equal(items.length, 2)
  assert.equal(items[0].source, 'step')
})

test('合并：一条活动只被消费一次（两个同工具步骤不会都吃掉同一条）', () => {
  const steps = [
    { role: 'assistant', content: 'a', kind: 'step', at: 1_000, tool: 'call_page_method', target: 'a', settled: true, ok: true },
    { role: 'assistant', content: 'b', kind: 'step', at: 1_050, tool: 'call_page_method', target: 'b', settled: true, ok: true },
  ]
  const items = mergeTimeline(steps, [call({ at: 1_010, name: 'a', durationMs: 5 })])
  assert.equal(items.length, 2, '第二条步骤没有活动可配 → 不重复消费')
  assert.equal(items.filter((i) => i.activity).length, 1)
})

test('合并：结果按时间正序（activity 可能比 step 先到）', () => {
  const steps = [
    { role: 'assistant', content: '后发生的步骤', kind: 'step', at: 2_000, tool: 'render', target: 'b', settled: true, ok: true },
  ]
  const items = mergeTimeline(steps, [{ at: 500, kind: 'data', name: '早期上报' }])
  assert.deepEqual(items.map((i) => i.at), [500, 2_000])
})

test('合并：活动文案兜底（没有 step 可配对的活动也要有人话）', () => {
  const items = mergeTimeline([], [
    { at: 1, kind: 'call', name: 'refresh' },
    { at: 2, kind: 'emit', name: 'saved' },
    { at: 3, kind: 'error', error: '炸了' },
  ])
  assert.equal(items[0].text, '调用 refresh()')
  assert.equal(items[1].text, '页面事件 saved')
  assert.equal(items[2].text, '错误：炸了')
})

// ── 过程区展示行组装 ───────────────────────────────────────────────────

/** TraceRow 是联合类型：item 行的文案在 `item.text`，思考 / 错误行在 `text` */
const rowText = (row) => (row.type === 'item' ? row.item.text : row.text)

test('行组装：step / reasoning / error 各自成行，按时间正序', () => {
  const trace = [
    { role: 'assistant', content: '思考一下', kind: 'reasoning', at: 10 },
    { role: 'assistant', content: '正在打开页面 <user-list>', kind: 'step', at: 20, tool: 'render', target: 'user-list', settled: true, ok: true },
    { role: 'assistant', content: '炸了', kind: 'error', at: 30 },
  ]
  const rows = buildTraceRows(trace)
  assert.deepEqual(rows.map((r) => r.type), ['reasoning', 'item', 'error'])
  assert.deepEqual(rows.map((r) => r.at), [10, 20, 30])
  assert.equal(rows[0].text, '思考一下')
  assert.equal(rows[2].text, '炸了')
})

test('行组装：runtime 活动并进同一条时间轴（且去重）', () => {
  const trace = [
    { role: 'assistant', content: '正在调用 当前页.setKeyword()', kind: 'step', at: 1_000, tool: 'call_page_method', target: 'setKeyword', settled: true, ok: true },
  ]
  const rows = buildTraceRows(trace, [call({ at: 1_100, durationMs: 40 })])
  assert.equal(rows.length, 1, 'step 与 activity 合成一行，不是两行')
  assert.equal(rows[0].item.durationMs, 40)
})

test('行组装：只保留最近 limit 行（过程区空间宝贵）', () => {
  const trace = Array.from({ length: 5 }, (_, i) => ({
    role: 'assistant',
    content: `步骤 ${i}`,
    kind: 'step',
    at: i + 1,
    tool: 'render',
    target: `page-${i}`,
    settled: true,
    ok: true,
  }))
  const rows = buildTraceRows(trace, [], 2)
  assert.deepEqual(rows.map(rowText), ['步骤 3', '步骤 4'])
})

test('行组装：结果气泡不进行（它们是 bubbles，不是过程）', () => {
  const rows = buildTraceRows([
    { role: 'assistant', content: '这是结果', kind: 'message', at: 1 },
    { role: 'assistant', content: '这是缺省 kind 的老消息', at: 2 },
  ])
  assert.deepEqual(rows, [])
})

test('行组装：key 稳定且不撞车（同毫秒两条步骤）', () => {
  const trace = [
    { role: 'assistant', content: 'a', kind: 'step', at: 5, tool: 'render', target: 'x', settled: true, ok: true },
    { role: 'assistant', content: 'b', kind: 'step', at: 5, tool: 'render', target: 'y', settled: true, ok: true },
  ]
  const keys = buildTraceRows(trace).map((r) => r.key)
  assert.equal(new Set(keys).size, 2)
})

