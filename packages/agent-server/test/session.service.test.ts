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
  const session = svc.createOrResume().session
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
  const session = svc.createOrResume().session
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
  const session = svc.createOrResume().session
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
  const session = svc.createOrResume().session
  svc.recordPageExposed(session, { tag: 'user-list', keys: ['refresh', 'setKeyword'] })
  svc.recordPageExposed(session, { tag: 'user-detail', keys: ['save'] })
  svc.recordPageExposed(session, { tag: 'user-list', keys: ['refresh', 'setKeyword', 'reset'] })
  assert.deepEqual(session.pageExposedKeys?.['user-list'], ['refresh', 'setKeyword', 'reset'])
  assert.deepEqual(session.pageExposedKeys?.['user-detail'], ['save'])
})

test('waitForObservation：page.data 的 source + contains 匹配（显式上报回归）', async () => {
  const svc = makeService()
  const session = svc.createOrResume().session
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
  const session = svc.createOrResume().session
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
  const session = svc.createOrResume().session
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
