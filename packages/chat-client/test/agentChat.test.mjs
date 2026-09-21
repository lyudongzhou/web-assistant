// useAgentChat 集成测：用**假 socket** 喂真实的 ServerMessage 序列，验完整分流链路。
//
// 为什么值得这么测：这次的 bug 不在单个纯函数里，而在「协议消息 → 消息列表 → UI 两栏」
// 这条**贯通**的路径上（过程行被 appendAssistant 拼进结果气泡）。只测 lib 的纯函数
// 证明不了链路上没有第二处拼接 —— 这里直接把消息灌进状态机，断言最终两栏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useAgentChat } from '../src/composables/useAgentChat.ts'

/** 假 socket：记录发出去的消息，不真连 WS */
function stubSocket() {
  const sent = []
  return {
    sent,
    connected: true,
    sendChat: (text) => sent.push({ t: 'chat.send', text }),
    sendToolResult: (result) => sent.push(result),
    sendCancel: () => sent.push({ t: 'chat.cancel' }),
    startNewSession: async () => {
      sent.push({ t: 'session.hello' })
      return { sessionId: 'stub-session' }
    },
  }
}

function makeChat(socket, hooks = {}) {
  return useAgentChat({
    socket: () => socket,
    onRender: hooks.onRender ?? (async () => {}),
    onCallPageMethod: hooks.onCallPageMethod ?? (async () => ({ ok: true, value: 'ok', async: false })),
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 只取 assistant 的答复 —— `bubbles` 里**也含用户自己的消息**（它们是气泡，不是过程），
 * 断言"结果气泡"时必须排掉用户那条（第一次写测试就在这儿踩到）。
 */
const answers = (chat) => chat.bubbles.value.filter((m) => m.role === 'assistant').map((m) => m.content)

test('完整一轮：结果气泡只有结果，过程（思考 + 步骤）独立成栏', () => {
  const socket = stubSocket()
  const chat = makeChat(socket)
  chat.send('打开用户列表，找一下李四')

  // server 侧推的真实形状（顺序与 traceEvents.ts 的投影一致）
  chat._handleServerMessage({ t: 'chat.text', delta: '我先看看', channel: 'reasoning' })
  chat._handleServerMessage({ t: 'chat.text', delta: '用户列表', channel: 'reasoning' })
  chat._handleServerMessage({
    t: 'agent.step', index: 1, phase: 'start',
    text: '正在打开页面 <user-list>', tool: 'render', target: 'user-list', args: { tag: 'user-list' },
  })
  chat._handleServerMessage({
    t: 'agent.step', index: 1, phase: 'end',
    text: '正在打开页面 <user-list>', tool: 'render', target: 'user-list', ok: true, durationMs: 180,
  })
  chat._handleServerMessage({ t: 'chat.text', delta: '已经打开了用户列表', channel: 'text' })
  chat._handleServerMessage({ t: 'chat.done', steps: 1, durationMs: 8_200 })

  assert.deepEqual(answers(chat), ['已经打开了用户列表'], '结果气泡里只有结果')
  assert.ok(
    chat.bubbles.value.filter((m) => m.role === 'assistant').every((m) => !m.content.includes('>')),
    '结果气泡里不再有 ">" 过程前缀',
  )
  assert.deepEqual(chat.trace.value.map((m) => m.kind), ['reasoning', 'step'])
  assert.equal(chat.trace.value[1].settled, true, 'start/end 合成一行而不是两行')
  assert.equal(chat.trace.value[1].durationMs, 180)
  assert.deepEqual(chat.traceSummary.value, { stepCount: 1, running: 0, failed: 0, durationMs: 8_200 })
  assert.equal(chat.loading.value, false)
})

test('结果与思考即使同轮交错，也不会拼进同一条消息', () => {
  const socket = stubSocket()
  const chat = makeChat(socket)
  chat.send('问题')

  chat._handleServerMessage({ t: 'chat.text', delta: '答', channel: 'text' })
  chat._handleServerMessage({ t: 'chat.text', delta: '想', channel: 'reasoning' })
  chat._handleServerMessage({ t: 'chat.text', delta: '案', channel: 'text' })

  assert.deepEqual(answers(chat), ['答案'])
  assert.deepEqual(chat.trace.value.map((m) => m.content), ['想'])
})

test('tool.call 不再往对话里塞「> 正在打开页面…」（过程文案唯一来源是 agent.step）', async () => {
  const socket = stubSocket()
  let rendered = null
  const chat = makeChat(socket, { onRender: async (args) => { rendered = args } })
  chat.send('打开用户列表')

  chat._handleServerMessage({ t: 'tool.call', id: 'c1', name: 'render', args: { tag: 'user-list' }, timeoutMs: 8_000 })
  await flush()

  assert.deepEqual(rendered, { tag: 'user-list' }, '渲染指令照旧派发')
  assert.equal(socket.sent.filter((m) => m.t === 'tool.result').length, 1, 'ack 照旧回流')
  assert.deepEqual(chat.trace.value, [], '没有凭空多出「过程行」（旧实现会在这里塞一条 > 正在打开页面…）')
})

test('call_page_method 的 tool.call 也不产生过程行，但会执行并回 tool.result', async () => {
  const socket = stubSocket()
  let called = null
  const chat = makeChat(socket, {
    onCallPageMethod: async (args) => {
      called = args
      return { ok: true, value: 12, async: false }
    },
  })
  chat.send('翻页')

  chat._handleServerMessage({
    t: 'tool.call', id: 'c2', name: 'call_page_method', args: { name: 'nextPage' }, timeoutMs: 8_000,
  })
  await flush()

  assert.deepEqual(called, { name: 'nextPage' })
  const result = socket.sent.find((m) => m.t === 'tool.result')
  assert.equal(result.ok, true)
  assert.equal(result.data.value, 12)
  assert.deepEqual(chat.trace.value, [])
})

test('chat.error 进过程区（错误不该被当成 agent 的答复）', () => {
  const socket = stubSocket()
  const chat = makeChat(socket)
  chat.send('问题')
  chat._handleServerMessage({ t: 'chat.error', message: 'Insufficient Balance' })

  assert.deepEqual(answers(chat), [])
  assert.deepEqual(chat.trace.value.map((m) => m.kind), ['error'])
  assert.equal(chat.trace.value[0].content, 'Insufficient Balance')
  assert.equal(chat.loading.value, false)
})

test('兼容：不带 channel 的 chat.text（旧 server）仍算结果气泡', () => {
  const socket = stubSocket()
  const chat = makeChat(socket)
  chat.send('问题')
  chat._handleServerMessage({ t: 'chat.text', delta: '旧版 server 的答复' })
  assert.deepEqual(answers(chat), ['旧版 server 的答复'])
  assert.deepEqual(chat.trace.value, [])
})

test('兼容：只推 phase:start 的旧 server（无 end）→ 步骤仍在，但标记进行中、无耗时', () => {
  const socket = stubSocket()
  const chat = makeChat(socket)
  chat.send('问题')
  chat._handleServerMessage({ t: 'agent.step', index: 1, text: '正在打开页面' })
  chat._handleServerMessage({ t: 'chat.done', steps: 1 })

  assert.deepEqual(chat.trace.value.map((m) => m.content), ['正在打开页面'])
  assert.equal(chat.trace.value[0].settled, false, '没收到 end → UI 显示进行中')
  assert.equal(chat.traceSummary.value.running, 1)
  assert.equal(chat.traceSummary.value.durationMs, undefined, '旧 server 无耗时则不显示')
})

test('欢迎语（握手时主动推）另起气泡，不与之后的结果粘连', () => {
  const socket = stubSocket()
  const chat = makeChat(socket)
  // 握手欢迎：chat.text{channel:text} + chat.done{steps:0}（agent.gateway.ts）
  chat._handleServerMessage({ t: 'chat.text', delta: '你好，我是助手', channel: 'text' })
  chat._handleServerMessage({ t: 'chat.done', steps: 0 })

  chat.send('打开用户列表')
  chat._handleServerMessage({ t: 'chat.text', delta: '好的', channel: 'text' })

  assert.deepEqual(answers(chat), ['你好，我是助手', '好的'])
})

test('startNewSession 清空两栏与本轮耗时', () => {
  const socket = stubSocket()
  const chat = makeChat(socket)
  chat.send('问题')
  chat._handleServerMessage({
    t: 'agent.step', index: 1, phase: 'start', text: '正在打开页面 <x>', tool: 'render', target: 'x',
  })
  chat._handleServerMessage({ t: 'chat.done', steps: 1, durationMs: 100 })
  assert.equal(chat.traceSummary.value.durationMs, 100)

  chat.startNewSession()
  assert.deepEqual(answers(chat), ['连接已重置，已开始新会话。'])
  assert.deepEqual(chat.trace.value, [])
  assert.equal(chat.traceSummary.value.durationMs, undefined)
})

test('跨轮：上一轮的步骤不会吃掉这一轮的文本（流式游标按轮重置）', () => {
  const socket = stubSocket()
  const chat = makeChat(socket)
  chat.send('第一问')
  chat._handleServerMessage({ t: 'chat.text', delta: '第一答', channel: 'text' })
  chat._handleServerMessage({
    t: 'agent.step', index: 1, phase: 'start', text: '正在打开页面 <a>', tool: 'render', target: 'a',
  })
  chat._handleServerMessage({
    t: 'agent.step', index: 1, phase: 'end', text: '正在打开页面 <a>', tool: 'render', target: 'a', ok: true, durationMs: 5,
  })
  chat._handleServerMessage({ t: 'chat.done', steps: 1, durationMs: 900 })

  chat.send('第二问')
  chat._handleServerMessage({ t: 'chat.text', delta: '第二答', channel: 'text' })

  assert.deepEqual(answers(chat), ['第一答', '第二答'], '两轮各自一条气泡，不粘连')
  assert.equal(chat.trace.value[0].settled, true)
})

