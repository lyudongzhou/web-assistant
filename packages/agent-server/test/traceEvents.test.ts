// traceEvents 单测：SDK 事件 → 客户端消息 的映射。
//
// 这是「思考的过程与结果分不开」事故点的**回归测试**：
//   - reasoning 增量必须走独立通道（此前根本没被订阅 → 真思考完全不可见）
//   - 工具步骤必须带 phase / tool / target（此前只有三条固定中文，两次 render 长得一样）
//   - end 必须闭合到 start 的耗时（此前只有 start，过程行永远悬空）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectTraceEvent, type TraceEventEnvelope } from '../src/agent/traceEvents.js'

/** 造事件（只填用到的字段） */
const text = (t: string, iteration = 1): TraceEventEnvelope => ({ type: 'assistant-text-delta', iteration, text: t })
const reasoning = (t: string, iteration = 1): TraceEventEnvelope => ({ type: 'assistant-reasoning-delta', iteration, text: t })
const started = (toolName: string, id: string, input?: unknown, iteration = 1): TraceEventEnvelope => ({
  type: 'tool-started',
  iteration,
  toolCall: { toolName, toolCallId: id, input },
})
const finished = (
  toolName: string,
  id: string,
  opts: { input?: unknown; error?: string; iteration?: number } = {},
): TraceEventEnvelope => ({
  type: 'tool-finished',
  iteration: opts.iteration ?? 1,
  toolCall: { toolName, toolCallId: id, input: opts.input },
  message: {
    parts: [{ type: 'tool-result', toolCallId: id, isError: !!opts.error, output: opts.error ?? { status: 'done' } }],
  },
})

// ── 结果与思考分走不同通道 ────────────────────────────────────────────

test('结果正文 → chat.text{channel:text}，并计入流式兜底', () => {
  const { messages, streamText } = projectTraceEvent(text('好的'), new Map(), 1)
  assert.deepEqual(messages, [{ t: 'chat.text', delta: '好的', channel: 'text' }])
  assert.equal(streamText, true)
})

test('模型思考 → chat.text{channel:reasoning}，且**不**计入流式兜底（outputText 不含 reasoning）', () => {
  const { messages, streamText } = projectTraceEvent(reasoning('先看看用户列表'), new Map(), 1)
  assert.deepEqual(messages, [{ t: 'chat.text', delta: '先看看用户列表', channel: 'reasoning' }])
  assert.equal(streamText, false)
})

test('空 delta 不推任何消息（不制造空消息）', () => {
  assert.deepEqual(projectTraceEvent(text(''), new Map(), 1).messages, [])
  assert.deepEqual(projectTraceEvent(reasoning(''), new Map(), 1).messages, [])
})

// ── 过程步骤：开始 ───────────────────────────────────────────────────

test('tool-started → agent.step{phase:start} 且带 tool / target / args', () => {
  const pairs = new Map()
  const { messages, streamText } = projectTraceEvent(
    started('render', 'c1', { tag: 'user-list', params: { keyword: '李四' } }),
    pairs,
    1_000,
  )
  assert.equal(streamText, false)
  assert.deepEqual(messages, [
    {
      t: 'agent.step',
      index: 1,
      phase: 'start',
      text: '正在打开页面 <user-list>',
      tool: 'render',
      target: 'user-list',
      args: { tag: 'user-list', params: { keyword: '李四' } },
    },
  ])
  assert.equal(pairs.get('c1'), 1_000, '开始时间被记下（end 才能算耗时）')
})

test('call_page_method 的步骤文案带「目标页 / 当前页」与目标方法名', () => {
  const messages = projectTraceEvent(
    started('call_page_method', 'c2', { name: 'setKeyword', args: ['钱'] }),
    new Map(),
    1,
  ).messages
  assert.equal(messages[0].text, '正在调用 当前页.setKeyword()')
  assert.equal(messages[0].target, 'setKeyword')
})

// ── 过程步骤：结算（闭合） ────────────────────────────────────────────

test('tool-finished → agent.step{phase:end} 且耗时由 start/end 配对算出', () => {
  const pairs = new Map()
  projectTraceEvent(started('render', 'c1', { tag: 'user-list' }), pairs, 1_000)
  const { messages } = projectTraceEvent(finished('render', 'c1', { input: { tag: 'user-list' } }), pairs, 1_180)

  assert.deepEqual(messages, [
    {
      t: 'agent.step',
      index: 1,
      phase: 'end',
      text: '正在打开页面 <user-list>',
      tool: 'render',
      target: 'user-list',
      ok: true,
      durationMs: 180,
    },
  ])
  assert.equal(pairs.size, 0, '配对用掉即清（同 id 不会二次算出耗时）')
})

test('tool-finished 失败（tool-result.isError）→ ok:false + error', () => {
  const pairs = new Map()
  projectTraceEvent(started('call_page_method', 'c2', { name: 'save' }), pairs, 100)
  const { messages } = projectTraceEvent(
    finished('call_page_method', 'c2', { input: { name: 'save' }, error: '方法未暴露' }),
    pairs,
    140,
  )
  assert.equal(messages[0].ok, false)
  assert.equal(messages[0].error, '方法未暴露')
  assert.equal(messages[0].durationMs, 40)
})

test('没配到 start 的 end 也照推（不丢一条"真发生过"的动作），只是没有耗时', () => {
  const { messages } = projectTraceEvent(finished('render', 'unknown-id', { input: { tag: 'user-list' } }), new Map(), 5)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].phase, 'end')
  assert.equal(messages[0].ok, true)
  assert.equal(messages[0].durationMs, undefined)
})

test('并行工具调用各自配对（不同 toolCallId 不串味）', () => {
  const pairs = new Map()
  projectTraceEvent(started('render', 'a', { tag: 'page-a' }), pairs, 0)
  projectTraceEvent(started('call_page_method', 'b', { name: 'refresh' }), pairs, 50)
  const endA = projectTraceEvent(finished('render', 'a', { input: { tag: 'page-a' } }), pairs, 300).messages[0]
  const endB = projectTraceEvent(finished('call_page_method', 'b', { input: { name: 'refresh' } }), pairs, 150).messages[0]
  assert.equal(endA.durationMs, 300)
  assert.equal(endB.durationMs, 100)
})

test('配对被清空后（每轮/abort 复位）→ 不再算出跨轮的离谱耗时', () => {
  const pairs = new Map()
  projectTraceEvent(started('render', 'c1', { tag: 'x' }), pairs, 0)
  pairs.clear() // 模拟 run 结束 / abort 时的复位
  const { messages } = projectTraceEvent(finished('render', 'c1', { input: { tag: 'x' } }), pairs, 999_999)
  assert.equal(messages[0].durationMs, undefined)
})

// ── 无关事件 / 兼容性 ────────────────────────────────────────────────

test('无关事件不对外可见（run-started / usage / turn-finished …）', () => {
  const pairs = new Map()
  for (const type of ['run-started', 'turn-started', 'turn-finished', 'usage-updated', 'message-added', 'status-notice']) {
    const { messages, streamText } = projectTraceEvent({ type }, pairs, 1)
    assert.deepEqual(messages, [], `${type} 不该产生消息`)
    assert.equal(streamText, false)
  }
})

test('缺 toolCall 的 tool-started / tool-finished 不抛（观测路径不能影响主流程）', () => {
  assert.deepEqual(projectTraceEvent({ type: 'tool-started' }, new Map(), 1).messages, [])
  assert.deepEqual(projectTraceEvent({ type: 'tool-finished' }, new Map(), 1).messages, [])
})

test('未知工具名也有兜底文案（不出现 undefined）', () => {
  const { messages } = projectTraceEvent(started('brand_new_tool', 'z', {}), new Map(), 1)
  assert.equal(messages[0].text, '正在执行 brand_new_tool')
  assert.equal(messages[0].tool, 'brand_new_tool')
})

