// 显式上报（apiBus）语义单测。
//
// 这一组锁死的是「数据出网的决定权在调用方」这条硬约束：
// 1. runtime 不自动采集 —— 不改写全局 fetch，不产生任何观察事件；
// 2. 只有显式 apiBus.report 才会产生 page-data 事件（没人调 = 零数据出网）；
// 3. dataSources 只是**可选**裁剪：命中按声明裁，未命中原样透传（仅体积硬上限）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../dist/runtime.js'
import { apiBus } from '../dist/apiBus.js'
import { createFakeAdapter, createFakeImporter, fakeRoot, makeManifest } from './helpers.js'

function setup(overrides = {}) {
  const { adapter } = createFakeAdapter('vue')
  const { importImpl } = createFakeImporter()
  const runtime = createRuntime({
    manifest: overrides.manifest ?? makeManifest(),
    assetBase: '/wc',
    adapters: [adapter],
    importImpl,
  })
  return { runtime }
}

test('apiBus：无人监听 → report 返回 false 且无副作用；attach 后返回 true', () => {
  const received = []
  assert.equal(apiBus.attached, false)
  assert.equal(apiBus.report({ source: 'x', data: { a: 1 } }), false, '无人监听时静默丢弃并返回 false')
  const detach = apiBus.attach((payload) => received.push(payload))
  assert.equal(apiBus.attached, true)
  assert.equal(apiBus.report({ source: 'x', data: { a: 1 } }), true)
  assert.deepEqual(received, [{ source: 'x', data: { a: 1 } }])
  detach()
  assert.equal(apiBus.attached, false)
})

test('apiBus：单 sink 语义 —— 覆盖已存在 sink 会告警，旧 detach 不误清新 sink', () => {
  const first = []
  const second = []
  const warns = []
  const originalWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  let detachSecond = null
  try {
    const detachFirst = apiBus.attach((payload) => first.push(payload))
    detachSecond = apiBus.attach((payload) => second.push(payload))
    assert.equal(warns.length, 1, '覆盖活着的 sink 应告警一次（典型误用：业务侧自己 attach）')
    assert.match(warns[0], /覆盖了已存在的 sink/)

    apiBus.report({ source: 's', data: 1 })
    assert.deepEqual(first, [], '被顶掉的 sink 不再收到数据')
    assert.deepEqual(second, [{ source: 's', data: 1 }])

    detachFirst()
    assert.equal(apiBus.attached, true, '旧 sink 的 detach 不应清掉新 sink（它是当前 sink）')
  } finally {
    detachSecond?.()
    console.warn = originalWarn
  }
  assert.equal(apiBus.attached, false, '用例结束应回到无监听状态，避免影响后续用例')
})

test('runtime：不自动采集 —— 不改写全局 fetch，且没有任何 page-data 事件', async () => {
  const before = globalThis.fetch
  const { runtime } = setup()
  const events = []
  runtime.on('page-data', (snapshot) => events.push(snapshot))
  await runtime.init(fakeRoot())
  assert.equal(globalThis.fetch, before, 'runtime 不应改写全局 fetch（自动网络观测已退役）')
  assert.deepEqual(events, [], '没人调用 apiBus.report → 零数据出网')
  runtime.dispose()
  assert.equal(globalThis.fetch, before, 'dispose 后全局 fetch 仍是原生实现')
})

test('runtime：显式 report → page-data 事件（补 page / at，数据原样透传）', async () => {
  const { runtime } = setup()
  const events = []
  runtime.on('page-data', (snapshot) => events.push(snapshot))
  await runtime.init(fakeRoot())

  assert.equal(apiBus.report({ source: 'user-list', data: [{ id: 1, name: '张三' }] }), true)
  assert.equal(events.length, 1)
  const [snapshot] = events
  assert.equal(snapshot.page, 'user-list', 'runtime 自动补当前页 tag')
  assert.equal(snapshot.source, 'user-list', 'source 由调用方给')
  assert.deepEqual(snapshot.data, [{ id: 1, name: '张三' }], '未声明 dataSources → 原样透传')
  assert.equal(snapshot.truncated, false)
  assert.equal(typeof snapshot.at, 'number')
  runtime.dispose()
})

test('runtime：命中 dataSources → 按 fields / maxRows 裁剪（可选加固）', async () => {
  const { runtime } = setup({
    manifest: makeManifest({
      pages: [{
        name: 'UserList',
        tag: 'user-list',
        path: '/users',
        framework: 'vue',
        bundle: 'pages/userList.js',
        dataSources: [{ match: '/api/users', fields: ['id', 'name'], maxRows: 1 }],
      }],
    }),
  })
  const events = []
  runtime.on('page-data', (snapshot) => events.push(snapshot))
  await runtime.init(fakeRoot())

  apiBus.report({
    url: '/api/users',
    source: 'ignored-when-matched',
    data: [{ id: 1, name: '张三', email: 'z@example.com' }, { id: 2, name: '李四' }],
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].source, '/api/users', '命中时 source 取 ds.match')
  assert.deepEqual(events[0].data, [{ id: 1, name: '张三' }], '只留声明字段 + 行数截断')
  assert.equal(events[0].truncated, true)
  runtime.dispose()
})

test('runtime：未命中 dataSources → 原样透传（不因声明而丢数据）', async () => {
  const { runtime } = setup({
    manifest: makeManifest({
      pages: [{
        name: 'UserList',
        tag: 'user-list',
        path: '/users',
        framework: 'vue',
        bundle: 'pages/userList.js',
        dataSources: [{ match: '/api/users', fields: ['id'] }],
      }],
    }),
  })
  const events = []
  runtime.on('page-data', (snapshot) => events.push(snapshot))
  await runtime.init(fakeRoot())

  apiBus.report({ url: '/api/orders', data: { total: 3 } })
  assert.equal(events.length, 1)
  assert.equal(events[0].source, '/api/orders', '未命中 → source 回退到 url')
  assert.deepEqual(events[0].data, { total: 3 })
  runtime.dispose()
})

test('runtime：超过体积硬上限 → truncated = true（防 token 爆）', async () => {
  const { runtime } = setup()
  const events = []
  runtime.on('page-data', (snapshot) => events.push(snapshot))
  await runtime.init(fakeRoot())

  const big = {
    list: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `用户-${i}`, email: `u${i}@example.com` })),
  }
  apiBus.report({ source: 'huge', data: big })
  assert.equal(events.length, 1)
  assert.equal(events[0].truncated, true)
  const capped = events[0].data
  const cappedSize = JSON.stringify(capped).length
  const rawSize = JSON.stringify(big).length
  assert.ok(capped.list.length < 2000, `数组行数被截断（${capped.list.length}/2000）`)
  assert.ok(rawSize > 64 * 1024, `原始数据要足够大才有对比意义（实际 ${rawSize}）`)
  assert.ok(cappedSize * 4 < rawSize, `裁剪后应远小于原始体积（${rawSize} → ${cappedSize}）`)
  assert.ok(cappedSize <= 16 * 1024 + 512, `裁剪后体积有上界（实际 ${cappedSize}）`)
  runtime.dispose()
})

test('runtime：dispose 后 detach —— 再 report 不再触发事件', async () => {
  const { runtime } = setup()
  const events = []
  runtime.on('page-data', (snapshot) => events.push(snapshot))
  await runtime.init(fakeRoot())
  runtime.dispose()
  assert.equal(apiBus.report({ source: 'after-dispose', data: 1 }), false)
  assert.deepEqual(events, [])
})
