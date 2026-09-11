// WS 链路冒烟（§4 验收）：模拟 chat-client 走完整协议。
// 前置：agent-server 已在本地起好（PORT 默认 3987，可改 WS_URL）。
// 用法：node test/smoke-ws.mjs
import WebSocket from 'ws'

const WS_URL = process.env.WS_URL || 'ws://localhost:3987/ws'
const ws = new WebSocket(WS_URL)
const seen = []
let step = 0

function send(msg) { ws.send(JSON.stringify(msg)); console.log('→', msg.t) }

const timer = setTimeout(() => {
  console.log('❌ 冒烟超时，收到的消息：', seen.map((m) => m.t).join(','))
  process.exit(1)
}, 90_000)

ws.on('open', () => {
  send({ t: 'session.hello', wcBase: '/wc', manifestVersion: 2 })
})

ws.on('message', (data) => {
  const msg = JSON.parse(String(data))
  seen.push(msg)
  if (msg.t !== 'chat.text') console.log('←', msg.t, JSON.stringify(msg).slice(0, 200))

  if (msg.t === 'session.ready') {
    send({ t: 'page.exposed', tag: 'user-list', keys: ['refresh', 'setKeyword'] })
    send({ t: 'page.emit', tag: 'user-list', event: 'selection-change', payload: { id: 7, name: '张三' } })
    send({ t: 'page.navigated', tag: 'user-list', params: {}, source: 'host' })
    send({ t: 'chat.send', text: '打开用户列表页' })
  }

  if (msg.t === 'tool.call') {
    // 模拟 chat-client 应答：render / call_page_method 都成功
    send({
      t: 'tool.result',
      id: msg.id,
      ok: true,
      data: msg.name === 'render' ? { accepted: true } : { value: 'ok' },
    })
    step += 1
  }

  if (msg.t === 'chat.done' || msg.t === 'chat.error') {
    clearTimeout(timer)
    const kinds = seen.map((m) => m.t)
    console.log('\n=== 冒烟结果 ===')
    console.log('消息序列:', kinds.join(' → '))
    const hasReady = kinds.includes('session.ready')
    const hasToolCall = kinds.includes('tool.call')
    const hasDone = kinds.includes('chat.done')
    if (hasReady && hasToolCall && hasDone) {
      console.log(`✅ 通过：握手 / 工具调用 / 完成 全部到位（tool.call 共 ${step} 次）`)
      process.exit(0)
    } else {
      console.log('❌ 缺少关键消息', { hasReady, hasToolCall, hasDone })
      process.exit(1)
    }
  }
})

ws.on('error', (err) => {
  clearTimeout(timer)
  console.log('❌ ws error', String(err?.message ?? err))
  process.exit(1)
})
