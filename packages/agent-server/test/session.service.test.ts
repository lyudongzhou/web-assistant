// SessionService 单测（node:test + tsx 直跑 src）。
// 覆盖：page.emit / page.data 入 observation、pageExposedKeys 覆盖语义、source / contains 匹配与超时。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionService } from '../src/session/session.service.js'

function makeService(): SessionService {
  return new SessionService()
}

test('recordObservation：page.emit 进入 recentObservations', () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordObservation(session, {
    type: 'page.emit',
    page: 'user-list',
    event: 'selection-change',
    payload: { id: 7, name: '张三' },
    emittedAt: Date.now(),
  })
  assert.equal(session.recentObservations.length, 1)
  assert.equal(session.recentObservations[0].type, 'page.emit')
})

test('waitForObservation：page.emit 的 contains 在 event+payload 上匹配', async () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordObservation(session, {
    type: 'page.emit',
    page: 'user-list',
    event: 'selection-change',
    payload: { id: 7, name: '张三' },
    emittedAt: Date.now(),
  })
  const got = await svc.waitForObservation(session.id, { page: 'user-list', contains: '张三' }, 500)
  assert.equal(got.status, 'completed')
  if (got.status === 'completed') {
    assert.equal(got.observations.length, 1)
    assert.equal(got.observations[0].type, 'page.emit')
  }
})

test('waitForObservation：不匹配的 contains 走超时路径', async () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordObservation(session, {
    type: 'page.emit',
    page: 'user-list',
    event: 'selection-change',
    payload: { id: 7 },
    emittedAt: Date.now(),
  })
  const got = await svc.waitForObservation(session.id, { contains: '李四' }, 200)
  assert.equal(got.status, 'timed_out')
})

test('recordPageExposed：同 tag 覆盖、不同 tag 隔离', () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordPageExposed(session, { tag: 'user-list', keys: ['refresh', 'setKeyword'] })
  svc.recordPageExposed(session, { tag: 'user-detail', keys: ['save'] })
  svc.recordPageExposed(session, { tag: 'user-list', keys: ['refresh', 'setKeyword', 'reset'] })
  assert.deepEqual(session.pageExposedKeys?.['user-list'], ['refresh', 'setKeyword', 'reset'])
  assert.deepEqual(session.pageExposedKeys?.['user-detail'], ['save'])
})

test('waitForObservation：page.data 的 source + contains 匹配（显式上报回归）', async () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordObservation(session, {
    type: 'page.data',
    page: 'user-list',
    source: 'user-list',
    data: { list: [{ id: 7, name: '张三' }] },
    truncated: false,
    at: Date.now(),
  })
  const got = await svc.waitForObservation(session.id, { source: 'user-list', contains: '张三' }, 500)
  assert.equal(got.status, 'completed')
  if (got.status === 'completed') assert.equal(got.observations[0].type, 'page.data')
})

test('waitForObservation：source 不匹配则走超时路径', async () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordObservation(session, {
    type: 'page.data',
    source: 'user-list',
    data: { id: 7 },
    truncated: false,
    at: Date.now(),
  })
  const got = await svc.waitForObservation(session.id, { source: 'order-list' }, 200)
  assert.equal(got.status, 'timed_out')
})

test('waitForObservation：实时等待（记录后到达的事件唤醒 waiter）', async () => {
  const svc = makeService()
  const session = svc.create()
  const pending = svc.waitForObservation(session.id, { page: 'user-list', contains: 'ok' }, 1_000)
  // 300ms 后事件到达
  setTimeout(() => {
    svc.recordObservation(session, {
      type: 'page.emit',
      page: 'user-list',
      event: 'save-done',
      payload: { result: 'ok' },
      emittedAt: Date.now(),
    })
  }, 300)
  const got = await pending
  assert.equal(got.status, 'completed')
  if (got.status === 'completed') {
    assert.equal(got.observations[0].type, 'page.emit')
  }
})

// ── 会话 = 连接（connection-scoped）────────────────────────────────────

test('create：每次调用都新建独立会话（不复用、不恢复）', () => {
  const svc = makeService()
  const a = svc.create()
  const b = svc.create()
  assert.notEqual(a.id, b.id)
  assert.deepEqual(a.recentObservations, [])
  // 两次 create 都是新会话：store 里是两条独立记录
  assert.equal(svc.find(a.id)?.id, a.id)
  assert.equal(svc.find(b.id)?.id, b.id)
})

test('destroy：删除会话本体（断开即回收，之后查不到）', () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordNavigation(session, { tag: 'user-list', params: {}, source: 'page', at: Date.now() })
  svc.destroy(session.id)
  assert.equal(svc.find(session.id), undefined)
})

test('destroy：立刻结束该会话的观察等待（不等超时）', async () => {
  const svc = makeService()
  const session = svc.create()
  const startedAt = Date.now()
  const pending = svc.waitForObservation(session.id, { contains: '永远不会到' }, 5_000)
  svc.destroy(session.id)
  const got = await pending
  // 关键：立即以 failed 结束，而不是等 5s 超时
  assert.equal(got.status, 'failed')
  assert.ok(Date.now() - startedAt < 1_000, `destroy 后应立即结束等待，实际耗时 ${Date.now() - startedAt}ms`)
})

test('destroy：只影响自己的会话，其它会话的等待继续有效', async () => {
  const svc = makeService()
  const a = svc.create()
  const b = svc.create()
  const pendingB = svc.waitForObservation(b.id, { contains: 'ok' }, 1_000)
  svc.destroy(a.id)
  setTimeout(() => {
    svc.recordObservation(b, {
      type: 'page.emit',
      page: 'user-list',
      event: 'save-done',
      payload: { result: 'ok' },
      emittedAt: Date.now(),
    })
  }, 100)
  const got = await pendingB
  assert.equal(got.status, 'completed')
})
