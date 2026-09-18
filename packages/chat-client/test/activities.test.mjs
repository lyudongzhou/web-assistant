// 「本轮动作」纯逻辑单测：截断、占位、时间线截取。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_DETAIL_CLIP,
  ACTIVITY_VISIBLE_LIMIT,
  activityKey,
  formatActivityDetail,
  formatActivityTime,
  selectVisibleActivities,
} from '../src/lib/activities.ts'

const call = (overrides = {}) => ({
  at: 1_700_000_000_000,
  kind: 'call',
  name: 'refresh',
  ok: true,
  ...overrides,
})

test('详情：args / result / error 各一段，用 · 连接', () => {
  assert.equal(formatActivityDetail(call({ args: { page: 2 }, result: 12 })), 'args：{"page":2} · result：12')
  assert.equal(formatActivityDetail(call({ ok: false, error: '方法未暴露' })), 'error：方法未暴露')
})

test('详情：三者都没有 → 明确占位（不是空白）', () => {
  assert.equal(formatActivityDetail(call()), '（无参数与返回值）')
})

test('详情：长参数按上限截断（一屏不会被一条长 JSON 糊满）', () => {
  const long = 'x'.repeat(ACTIVITY_DETAIL_CLIP + 50)
  const text = formatActivityDetail(call({ args: long }))
  assert.equal(text, `args：${'x'.repeat(ACTIVITY_DETAIL_CLIP)}…`)
})

test('详情：循环引用不抛（回落 String()）', () => {
  const circular = {}
  circular.self = circular
  const text = formatActivityDetail(call({ args: circular }))
  assert.match(text, /^args：\[object Object\]$/)
})

test('时间：本地 24 小时制', () => {
  const at = new Date(2026, 0, 2, 9, 5, 7).getTime()
  assert.equal(formatActivityTime(at), '09:05:07')
})

test('可见列表：只取最近 N 条（时间线最新在前）', () => {
  const list = Array.from({ length: 5 }, (_, index) => call({ at: index }))
  assert.deepEqual(selectVisibleActivities(list, 2).map((a) => a.at), [0, 1])
  assert.equal(selectVisibleActivities(list).length, 5)
  assert.equal(ACTIVITY_VISIBLE_LIMIT, 40)
})

test('key：同毫秒同 kind 的不同方法不会撞车', () => {
  assert.notEqual(activityKey(call({ name: 'a' })), activityKey(call({ name: 'b' })))
})
