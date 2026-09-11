import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServicesRef, looksFrameworkBound } from '../dist/services.js'
import { createStateBridge } from '../dist/state.js'

test('state：浅合并 + 只在真正变化时通知 + 返回变更 key', () => {
  const bridge = createStateBridge({ user: { id: 1 }, perms: ['a'] })
  const seen = []
  bridge.subscribe((patch, keys) => seen.push([patch, keys]))

  assert.deepEqual(bridge.set({ user: { id: 1 } }).length, 1, '新对象引用视为变化')
  assert.deepEqual(bridge.set({ perms: bridge.current.perms }), [], '同引用不算变化')
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0][1], ['user'])
})

test('state：current 是稳定引用（容器可 provide 一次）', () => {
  const bridge = createStateBridge({ a: 1 })
  const ref = bridge.current
  bridge.set({ a: 2, b: 3 })
  assert.equal(bridge.current, ref, '引用不变')
  assert.deepEqual(bridge.get(), { a: 2, b: 3 })
})

test('services：ref 稳定，setServices 只广播真正变化的 key', () => {
  const request = () => {}
  const ref = createServicesRef({ request, locale: 'zh-CN' })
  const changes = []
  ref.subscribe((_, change) => changes.push(change))

  assert.equal(ref.current.request, request)
  ref.set({ request }) // 同引用
  assert.deepEqual(changes, [])

  ref.set({ locale: 'en-US' })
  assert.deepEqual(changes, [{ kind: 'services', keys: ['locale'] }])
  assert.equal(ref.current.locale, 'en-US')
})

test('services：state 走 state 通道，且 current.state 与 ref.state 同引用', () => {
  const ref = createServicesRef({ state: { user: { id: 1 } } })
  const changes = []
  ref.subscribe((_, change) => changes.push(change))

  assert.equal(ref.current.state, ref.state)
  ref.setState({ user: { id: 2 } })
  assert.deepEqual(changes, [{ kind: 'state', keys: ['user'] }])
  assert.deepEqual(ref.state.user, { id: 2 })
  assert.equal(ref.current.state, ref.state, 'state 引用始终稳定')
})

test('services：setServices 里带 state 时同时走两个通道', () => {
  const ref = createServicesRef({})
  const kinds = []
  ref.subscribe((_, change) => kinds.push(change.kind))
  ref.set({ locale: 'en', state: { a: 1 } })
  assert.deepEqual(kinds, ['services', 'state'])
})

test('services：误传框架响应式实例时告警（跨副本响应式不互通）', () => {
  const original = console.warn
  const warns = []
  console.warn = (msg) => warns.push(String(msg))
  try {
    createServicesRef({ request: { __v_isRef: true } })
    createServicesRef({ extras: { __v_isRef: true } }) // extras 属中立字段，不告警
    const ref = createServicesRef({})
    ref.set({ request: { _s: new Map(), _e: {} } })
  } finally {
    console.warn = original
  }
  assert.equal(warns.length, 2)
  assert.match(warns[0], /vue ref/)
  assert.match(warns[1], /pinia 实例/)
})

test('services：looksFrameworkBound 识别常见实例', () => {
  assert.equal(looksFrameworkBound({ __v_isRef: true }), 'vue ref')
  assert.equal(looksFrameworkBound({ __v_isReactive: true }), 'vue reactive')
  assert.equal(looksFrameworkBound({ _s: new Map(), _e: {} }), 'pinia 实例')
  assert.equal(looksFrameworkBound({ global: {}, mode: 'composition', install() {} }), 'vue-i18n 实例')
  assert.equal(looksFrameworkBound(() => {}), null, '纯函数放行')
  assert.equal(looksFrameworkBound({ get: () => {} }), null)
})
