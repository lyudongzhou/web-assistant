// agentSocket 单测：会话 = 连接（不持久化会话标识、重连即新会话）。
// 用假的 WebSocket / sessionStorage：断言「零存储访问」「hello 不带 sessionId」「第 2 次握手触发 onSessionReset」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentSocket } from '../src/lib/agentSocket.ts'

/** 假 WebSocket：记录发出的消息，并可手动驱动 open / message / close。 */
class FakeWebSocket {
  static OPEN = 1
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  static last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  }

  static reset() {
    FakeWebSocket.instances = []
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }

  fireOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  fireMessage(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

/** 记录所有存储访问：用来断言客户端不再读写 sessionStorage / localStorage。 */
function makeStorageSpy() {
  const accesses = []
  const make = (name) => ({
    getItem(key) { accesses.push(`get:${name}:${key}`); return null },
    setItem(key, value) { accesses.push(`set:${name}:${key}`); return value },
    removeItem(key) { accesses.push(`remove:${name}:${key}`) },
    clear() { accesses.push(`clear:${name}`) },
  })
  return { accesses, sessionStorage: make('session'), localStorage: make('local') }
}

/** 安装/还原测试所需全局（WebSocket / location / 存储 spy）。 */
function setup() {
  const original = {
    WebSocket: globalThis.WebSocket,
    location: globalThis.location,
    sessionStorage: globalThis.sessionStorage,
    localStorage: globalThis.localStorage,
  }
  const storage = makeStorageSpy()
  FakeWebSocket.reset()
  globalThis.WebSocket = FakeWebSocket
  globalThis.location = { protocol: 'http:', host: 'localhost:3000' }
  globalThis.sessionStorage = storage.sessionStorage
  globalThis.localStorage = storage.localStorage
  return {
    storage,
    restore() {
      globalThis.WebSocket = original.WebSocket
      globalThis.location = original.location
      globalThis.sessionStorage = original.sessionStorage
      globalThis.localStorage = original.localStorage
    },
  }
}

test('握手：session.hello 不带 sessionId，且全程零存储访问', async () => {
  const env = setup()
  try {
    const socket = createAgentSocket({ wsBase: '/ws', wcBase: '/wc' })
    const connecting = socket.connect()
    const ws = FakeWebSocket.last()
    assert.ok(ws, '应创建 WebSocket 连接')
    ws.fireOpen()
    ws.fireMessage({ t: 'session.ready', sessionId: 's-1', manifestVersion: 2 })
    const result = await connecting

    assert.equal(result.sessionId, 's-1')
    assert.deepEqual(ws.sent, [{ t: 'session.hello', wcBase: '/wc', manifestVersion: 2 }])
    assert.equal(Object.hasOwn(ws.sent[0], 'sessionId'), false, 'hello 不应携带会话标识')
    assert.deepEqual(env.storage.accesses, [], '不应读写 sessionStorage / localStorage')
    socket.disconnect()
  } finally {
    env.restore()
  }
})

test('startNewSession：断开重连 → 服务端新会话，onSessionReset 恰好触发一次', async () => {
  const env = setup()
  try {
    const resets = []
    const socket = createAgentSocket({ onSessionReset: (id) => resets.push(id) })
    const first = socket.connect()
    const ws1 = FakeWebSocket.last()
    ws1.fireOpen()
    ws1.fireMessage({ t: 'session.ready', sessionId: 's-1', manifestVersion: 2 })
    await first
    assert.deepEqual(resets, [], '首次连接不算会话重置')

    const next = socket.startNewSession()
    const ws2 = FakeWebSocket.last()
    assert.notEqual(ws2, ws1, '应建立新连接（会话 = 连接）')
    ws2.fireOpen()
    ws2.fireMessage({ t: 'session.ready', sessionId: 's-2', manifestVersion: 2 })
    const result = await next

    assert.equal(result.sessionId, 's-2')
    assert.deepEqual(resets, ['s-2'], '第 2 次握手 = 新会话 → 通知上层重置 UI')
    assert.equal(Object.hasOwn(ws2.sent[0], 'sessionId'), false)
    socket.disconnect()
  } finally {
    env.restore()
  }
})

test('掉线自动重连：重连后的握手同样视为新会话', async () => {
  const env = setup()
  try {
    const resets = []
    const socket = createAgentSocket({ onSessionReset: (id) => resets.push(id) })
    const first = socket.connect()
    const ws1 = FakeWebSocket.last()
    ws1.fireOpen()
    ws1.fireMessage({ t: 'session.ready', sessionId: 's-1', manifestVersion: 2 })
    await first

    // 服务端掉线（不是主动断开）→ 退避后自动重连
    ws1.onclose?.()
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    const ws2 = FakeWebSocket.last()
    assert.notEqual(ws2, ws1, '应自动重连出新连接')
    ws2.fireOpen()
    ws2.fireMessage({ t: 'session.ready', sessionId: 's-3', manifestVersion: 2 })
    assert.deepEqual(resets, ['s-3'])
    assert.equal(socket.sessionId, 's-3')
    socket.disconnect()
  } finally {
    env.restore()
  }
})
