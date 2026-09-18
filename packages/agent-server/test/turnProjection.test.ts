// turnProjection 单测（node:test + tsx 直跑 src）。
// 覆盖：预算裁剪、工具调用/结果成对保留、边界（不足上限 / 上限为 1 / 全孤儿）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectTurnMessages } from '../src/agent/turnProjection.js'

/** 造一条消息（content 仅用于投影判断的部件） */
function msg(parts: { type: string; toolCallId?: string }[]) {
  return { content: parts }
}

const text = (t: string) => msg([{ type: 'text' }])
const call = (id: string) => msg([{ type: 'tool-call', toolCallId: id }])
const result = (id: string) => msg([{ type: 'tool-result', toolCallId: id }])

test('projectTurnMessages：未超过上限时原样返回（不裁剪）', () => {
  const messages = [text('a'), call('c1'), result('c1'), text('b')]
  const projected = projectTurnMessages(messages, 10)
  assert.deepEqual(projected, messages)
})

test('projectTurnMessages：超过上限时只保留最近 N 条', () => {
  const messages = Array.from({ length: 10 }, (_, i) => text(`m${i}`))
  const projected = projectTurnMessages(messages, 3)
  assert.equal(projected.length, 3)
  assert.deepEqual(projected, messages.slice(7))
})

test('projectTurnMessages：窗口首条是孤儿 tool-result 时继续往后推（成对保留）', () => {
  // 窗口切在 call/result 之间：最近 3 条 = [result c1, mid, new]，首条 result 的 call 已被截掉
  const messages = [text('old'), call('c1'), result('c1'), text('mid'), text('new')]
  const projected = projectTurnMessages(messages, 3)
  assert.deepEqual(projected, [text('mid'), text('new')])
  // 投影里不残留任何「调用已丢失」的 tool-result
  assert.equal(
    projected.some((m) => m.content.some((p) => p.type === 'tool-result')),
    false,
  )
})

test('projectTurnMessages：完整保留窗口内的 call + result 对', () => {
  const messages = [text('m0'), text('m1'), call('c1'), result('c1')]
  const projected = projectTurnMessages(messages, 3)
  // 最近 3 条 = call c1 + result c1 → 首条不是孤儿，原样保留
  assert.deepEqual(projected, [text('m1'), call('c1'), result('c1')])
})

test('projectTurnMessages：上限为 1 或 0 时也不会返回空（至少保留最后一条）', () => {
  const messages = [text('a'), text('b')]
  assert.deepEqual(projectTurnMessages(messages, 1), [text('b')])
  assert.deepEqual(projectTurnMessages(messages, 0), [text('b')])
})

test('projectTurnMessages：全部是孤儿 tool-result 时至少保留最后一条', () => {
  const messages = [result('c1'), result('c1')]
  const projected = projectTurnMessages(messages, 1)
  assert.equal(projected.length, 1)
  assert.deepEqual(projected, [result('c1')])
})
