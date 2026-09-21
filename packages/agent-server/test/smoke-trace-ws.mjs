// 过程/结果分离的**链路**冒烟（§A3/A4 验收）：模拟 chat-client 走完整协议，
// 断言 server 侧确实把「思考 / 过程 / 结果」推成了**可区分**的形状。
//
// 前置：agent-server 已在本地起好（PORT 默认 3987，可改 WS_URL）。
// 用法：node test/smoke-trace-ws.mjs
//
// 与 smoke-ws.mjs 的分工：那个只验「链路通」（握手 / tool.call / done），
// 这个验「过程与结果在协议层就分得开」—— 正是本次修复的验收点。
import WebSocket from 'ws'

const WS_URL = process.env.WS_URL || 'ws://localhost:3987/ws'
const ws = new WebSocket(WS_URL)
const seen = []

function send(msg) {
  ws.send(JSON.stringify(msg))
  console.log('→', msg.t)
}

const timer = setTimeout(() => {
  console.log('❌ 冒烟超时，收到的消息：', seen.map((m) => m.t).join(','))
  process.exit(1)
}, 120_000)

ws.on('open', () => {
  send({ t: 'session.hello', wcBase: '/wc', manifestVersion: 2 })
})

ws.on('message', (data) => {
  const msg = JSON.parse(String(data))
  seen.push(msg)
  if (msg.t !== 'chat.text') console.log('←', msg.t, JSON.stringify(msg).slice(0, 240))

  if (msg.t === 'session.ready') {
    // 造一个「当前页 + 可用方法」，让 agent 有机会走 call_page_method（那一步才有 tool-finished 配对）
    send({ t: 'page.exposed', tag: 'user-list', keys: ['refresh', 'setKeyword', 'nextPage'] })
    send({ t: 'page.navigated', tag: 'user-list', params: {}, source: 'host' })
    send({ t: 'chat.send', text: '打开用户列表页' })
  }

  if (msg.t === 'tool.call') {
    send({
      t: 'tool.result',
      id: msg.id,
      ok: true,
      data: msg.name === 'render' ? { status: 'done', target: msg.args?.tag } : { status: 'success', value: 'ok' },
    })
  }

  // ⚠️ 完成信号要挑对：**握手时的欢迎语**也会推一条 `chat.done{steps:0}`（agent.gateway.ts），
  // 那不是一次 agent run —— 用它收尾会在 agent 还没开始跑时就退出（第一次跑就这么踩到的）。
  // 真正的 run 收尾要么已有过程步骤，要么带本轮耗时（本次改动新加）。
  const isRunDone = msg.t === 'chat.done' && (msg.durationMs !== undefined || seen.some((m) => m.t === 'agent.step'))
  if (isRunDone || msg.t === 'chat.error') {
    clearTimeout(timer)
    report(msg.t === 'chat.error')
    process.exit(0)
  }
})

ws.on('error', (err) => {
  clearTimeout(timer)
  console.log('❌ ws error', String(err?.message ?? err))
  process.exit(1)
})

function report(errored = false) {
  const kinds = seen.map((m) => m.t)
  const steps = seen.filter((m) => m.t === 'agent.step')
  const starts = steps.filter((s) => (s.phase ?? 'start') === 'start')
  const ends = steps.filter((s) => s.phase === 'end')
  const texts = seen.filter((m) => m.t === 'chat.text')
  const reasoning = texts.filter((m) => m.channel === 'reasoning')
  const answers = texts.filter((m) => m.channel !== 'reasoning')
  // ⚠️ 要取**本轮 run 的** done：`seen` 里第一条 chat.done 是握手欢迎语那条（steps:0、无耗时）。
  const done = seen.filter((m) => m.t === 'chat.done').at(-1)

  console.log('\n=== 过程/结果分离 冒烟结果 ===')
  if (errored) console.log('⚠️  本轮以 chat.error 结束（下面按已收到的消息判定）')
  console.log('消息序列:', kinds.join(' → '))

  const checks = []
  const check = (name, pass, extra = '') => {
    checks.push({ name, pass })
    console.log(`${pass ? '✅' : '❌'} ${name}${extra ? ` —— ${extra}` : ''}`)
  }

  check('过程步骤带 phase:start 且带 tool/target', starts.length > 0 && starts.every((s) => s.tool && s.target),
    starts.map((s) => `${s.tool}:${s.target}`).join(', ') || '（无）')
  check('每步都有配对的 phase:end（过程能"闭合"）', starts.length > 0 && ends.length === starts.length,
    `start=${starts.length} end=${ends.length}`)
  check('end 带成败与耗时', ends.every((e) => typeof e.ok === 'boolean') && ends.some((e) => typeof e.durationMs === 'number'),
    ends.map((e) => `${e.ok ? '✓' : '✗'}${e.durationMs ?? '-'}ms`).join(', '))
  check('结果正文走 channel:text（有答复文本）', answers.length > 0, `${answers.length} 段`)
  check('chat.done 带本轮耗时', !!done && typeof done.durationMs === 'number',
    done ? `steps=${done.steps} ${done.durationMs}ms` : '（无 done）')
  check('结果与思考分走两个通道（思考有内容时应出现 reasoning）',
    reasoning.length === 0 || reasoning.every((m) => m.channel === 'reasoning') && answers.every((m) => m.channel === 'text'),
    `text=${answers.length} 段 / reasoning=${reasoning.length} 段`)
  check('过程文案不再需要客户端拼 ">" 前缀（server 自带 target）',
    starts.every((s) => !s.text.startsWith('>')), starts[0]?.text ?? '（无）')

  // reasoning 不是失败条件：非推理模型本来就没有推理增量（通道为空是正常降级）
  console.log(`ℹ️  思考通道（channel:reasoning）：${reasoning.length ? `${reasoning.length} 段（模型有推理）` : '空（当前模型无推理增量，属正常降级）'}`)

  const failed = checks.filter((c) => !c.pass)
  console.log(failed.length ? `\n❌ ${failed.length} 项未通过` : `\n✅ ${checks.length} 项全部通过`)
  process.exit(failed.length ? 1 : 0)
}
