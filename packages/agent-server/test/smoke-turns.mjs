// 回合边界冒烟（`add-agent-modes-and-plan-turns` 的端到端验收）：模拟 chat-client 走完整协议。
//
// 前置：agent-server 已在本地起好（默认 3987，可用 WS_URL 覆盖），且 manifest 可读。
// 用法：node test/smoke-turns.mjs
//      SMOKE_EXPECT=revise node test/smoke-turns.mjs   ← 交互式计划修订（add-interactive-plan-revision）
//      SMOKE_EXPECT=handoff node test/smoke-turns.mjs  ← 人工步骤与人机交接（add-plan-manual-steps）
//
// 覆盖四条验收：
//   ① 复杂任务（plan 模式）→ chat.mode(plan) → propose_plan → chat.plan + chat.done(endedBy=propose_plan)
//   ② 用户确认计划 → chat.send(planId) → render 被放行（不再被门禁拦）→ 本轮以 finish_turn / 模型收尾
//   ③ 全程不出现 chat.error（步数用尽只会是「已暂停」）
//   ④ `SMOKE_EXPECT=revise`：不确认、先提修改意见（chat.send 带 revisePlanId）→ 要求
//      **同一 planId** 回来、`revision === 2`、未改动的步骤 id 保持不变（进度不被清掉），再确认执行
//   ⑤ `SMOKE_EXPECT=handoff`：执行到 agent 做不了的一步（写后端）→ handoff_step 交回用户
//      （计划卡上该步 `waiting-user` + 指引）→ 脚本模拟用户点「我已完成，下一步」（chat.send 带
//      `planId` + `stepDoneId`）→ 校验（可能带 issue 要求重做），全程无错
import WebSocket from 'ws'

const WS_URL = process.env.WS_URL || 'ws://localhost:3987/ws'
const MAX_ROUNDS = Number(process.env.SMOKE_ROUNDS || 3)
/**
 * 期望的验收口径：
 * - `plan`（默认）：计划 → 确认 → 执行
 * - `pause`：步数用尽只应「暂停」，不应报错
 * - `ask`：信息不足 → 问题卡 → 回答后续跑
 * - `revise`：计划 → **修改计划**（增量修订）→ 确认 → 执行
 * - `handoff`：计划 → 确认 → 某一步交回用户 → **模拟用户点「我已完成，下一步」** → 校验并继续
 */
const EXPECT = process.env.SMOKE_EXPECT || 'plan'
/** 本轮模式（`plan` / `act` / `auto`） */
const MODE = process.env.SMOKE_MODE || 'plan'
const TASK =
  process.env.SMOKE_TASK ||
  (EXPECT === 'handoff'
    ? // 交接档要用"写后端"的任务逼出人工步骤：demo 页的「新建 / 保存」不在可调用方法清单里，
      // 按规则 16 模型只能 handoff_step 交回用户（而不是自己硬试）
      '帮我打开数据源列表，然后新建一个数据源「订单库」并保存，最后确认它出现在列表里'
    : '帮我先打开数据源列表，然后逐个查看每个数据源的配置，最后汇总对比并给出结论')
/** 修订场景里用户写下的修改意见（会在下一轮作为 chat.send.text 发出） */
const REVISE_TEXT = process.env.SMOKE_REVISE_TEXT || '第 2 步改成导出 CSV 对比，其余步骤保持不动'
/**
 * 交接档的"校验不通过"变体：假页面数据里**不含**用户新建的那条记录 ——
 * 模型校验时会发现"没落库"，按规则 17 必须 `handoff_step({ issue })` 把该步交回重做。
 * 用它验证 R3（纠错提示）与"不许静默往下走"。
 */
const HANDOFF_MISSING = process.env.SMOKE_HANDOFF_MISSING === '1'

const ws = new WebSocket(WS_URL)
const seen = []
const errors = []
let rounds = 0
let approvedPlanId = null
let currentTag = null
/** 计划确认前是否出现过 render 的 tool.call —— 出现即说明 plan 门禁没拦住 */
let renderBeforePlan = false
let renders = 0
/** 修订场景：首版计划 / 修订后的计划（用于断言"同一份计划被改了"） */
let firstPlan = null
let revisedPlan = null
/** 交接档：是否出现过"等你操作"的步骤 / 是否已模拟用户点过按钮 / 用户步骤是否被推进 / 是否出现过 issue */
let handoffSeen = false
let stepDoneSent = false
let userStepDone = false
let stepIssue = null
/** 交接档的重做路径：是否见过 `issue`（校验不通过被交回重做）/ 是否已模拟"我已重做"再点一次 */
let reworkSeen = false
let issueRetrySent = false

function send(msg) {
  ws.send(JSON.stringify(msg))
  console.log('→', msg.t, msg.planId ?? msg.revisePlanId ?? msg.stepDoneId ?? msg.questionId ?? msg.mode ?? '')
}

function finish(code) {
  const kinds = seen.map((m) => m.t)
  const plans = seen.filter((m) => m.t === 'chat.plan').length
  const asks = seen.filter((m) => m.t === 'chat.ask').length
  const modes = seen.filter((m) => m.t === 'chat.mode').map((m) => `${m.requested}->${m.effective}(${m.decidedBy})`)
  const ended = seen.filter((m) => m.t === 'chat.done' && m.steps > 0).map((m) => m.endedBy ?? 'model')
  console.log('\n──────── 冒烟结果 ────────')
  console.log('消息序列：', kinds.join(' → '))
  console.log('模式判定：', modes.join(' | ') || '（无）')
  console.log('计划卡：', plans, '张；问题卡：', asks, '张；render：', renders, '次')
  console.log('本轮结束方式：', ended.join(' | ') || '（无）')
  // "偷跑 render"只在计划模式（plan）下有语义：act 模式本就该直接操作页面
  if (MODE === 'plan') {
    console.log('计划确认前是否偷跑 render：', renderBeforePlan ? '是 ❌（门禁失效）' : '否 ✅')
  }
  console.log('chat.error：', errors.length ? errors.join(' ; ') : '无 ✅')
  const paused = seen.some((m) => m.t === 'chat.text' && typeof m.delta === 'string' && m.delta.includes('已暂停'))
  console.log('是否出现「已暂停」提示：', paused ? '是 ✅' : '否')
  // 修订档的断言：同一 planId + revision=2 + 未改动的步骤 id 保持（"改计划"没有变成"换计划"）
  const samePlanId = !!revisedPlan && !!firstPlan && revisedPlan.planId === firstPlan.planId
  const revisionAdvanced = revisedPlan?.revision === 2
  const keptStepIds =
    !!revisedPlan && !!firstPlan && firstPlan.steps.some((step) => revisedPlan.steps.some((s) => s.id === step.id))
  if (EXPECT === 'revise') {
    console.log('修订是否同一 planId：', samePlanId ? '是 ✅' : `否 ❌（${firstPlan?.planId} → ${revisedPlan?.planId}）`)
    console.log('修订后的版本号：', revisedPlan?.revision ?? '（无）', revisionAdvanced ? '✅' : '❌')
    console.log('未改动的步骤 id 是否保留：', keptStepIds ? '是 ✅' : '否 ❌')
    if (revisedPlan) console.log('   ↳ 修订后步骤：', revisedPlan.steps.map((step) => `${step.id} ${step.title}`).join(' / '))
  }
  // 交接档的断言：出现过"等你操作"的步骤 + 用户点过按钮 + 该步被服务端推进（或给出重做原因）
  if (EXPECT === 'handoff') {
    console.log('是否交接过人工步骤（waiting-user）：', handoffSeen ? '是 ✅' : '否 ❌')
    console.log('是否模拟用户点过「我已完成，下一步」：', stepDoneSent ? '是 ✅' : '否 ❌')
    console.log('用户步骤是否被推进为 done：', userStepDone ? '是 ✅' : '否')
    console.log('是否出现「需重做」提示（issue）：', stepIssue ? `是（${stepIssue}）` : '否（本轮校验通过）')
    console.log('结束方式是否为 handoff_step：', ended.includes('handoff_step') ? '是 ✅' : '否 ❌')
    if (HANDOFF_MISSING) {
      // 假页面数据里没有新建的那条 → 模型校验必须失败，并按规则 17 用 issue 把该步交回重做
      console.log('（SMOKE_HANDOFF_MISSING=1）是否走了"需你重做"这条路径：', reworkSeen ? '是 ✅' : '否 ❌')
    }
  }
  const ok =
    EXPECT === 'pause'
      // 步数用尽档：不许有 chat.error，且必须给出「已暂停」（可继续）的可见提示
      ? errors.length === 0 && paused
      : EXPECT === 'ask'
        // 提问档：必须出现问题卡，且全程无错
        ? errors.length === 0 && asks >= 1
        : EXPECT === 'revise'
          // 修订档：同一份计划被增量改了（planId 不变、revision=2、步骤 id 保留），再确认执行
          ? errors.length === 0 && plans >= 2 && samePlanId && revisionAdvanced && keptStepIds && renders >= 1
          : EXPECT === 'handoff'
            // 交接档：发生了交接（waiting-user）→ 用户推进被接受（该步 done 或带回重做原因）→ 无错
            // （`SMOKE_HANDOFF_MISSING=1` 时还要求真的走了"需你重做"这条路径）
            ? errors.length === 0 &&
              handoffSeen &&
              stepDoneSent &&
              ended.includes('handoff_step') &&
              (userStepDone || !!stepIssue) &&
              (!HANDOFF_MISSING || reworkSeen)
            : errors.length === 0 && plans >= 1 && renders >= 1 && !renderBeforePlan
  const label =
    EXPECT === 'pause'
      ? '步数用尽降级为「已暂停」而非报错'
      : EXPECT === 'ask'
        ? '信息不足时弹出问题卡（ask_user 回合）'
        : EXPECT === 'revise'
          ? '计划修改是**增量修订**（同 planId / revision=2 / 步骤 id 保留）而非重新生成'
          : EXPECT === 'handoff'
            ? '人工步骤交回用户 → 用户点「我已完成，下一步」→ 服务端推进该步（或给出重做原因）'
            : '计划式回合跑通（计划 → 确认 → 执行），且无错误'
  console.log(ok ? `✅ 通过：${label}` : '❌ 未通过：见上')
  process.exit(ok && code === 0 ? 0 : 1)
}

const timer = setTimeout(() => {
  console.log('⏳ 冒烟超时，收到的消息：', seen.map((m) => m.t).join(','))
  finish(1)
}, 180_000)

ws.on('open', () => send({ t: 'session.hello', wcBase: '/wc', manifestVersion: 2 }))
ws.on('error', (error) => {
  console.error('ws error', error)
  clearTimeout(timer)
  finish(1)
})

ws.on('message', (data) => {
  const msg = JSON.parse(String(data))
  seen.push(msg)
  if (msg.t === 'chat.text') console.log('← chat.text', JSON.stringify(msg.delta).slice(0, 160))
  else console.log('←', msg.t, JSON.stringify(msg).slice(0, 240))

  if (msg.t === 'session.ready') {
    send({ t: 'chat.send', text: TASK, mode: MODE })
    return
  }

  if (msg.t === 'chat.error') {
    errors.push(msg.message)
    return
  }

  // 模拟 chat-client：render / call_page_method 都当成功；顺带上报一份页面数据让 wait 能结束
  if (msg.t === 'tool.call') {
    if (msg.name === 'render') {
      renders += 1
      if (!approvedPlanId) renderBeforePlan = true
      currentTag = msg.args?.tag ?? null
      send({ t: 'page.navigated', tag: currentTag, params: msg.args?.params ?? {}, source: 'agent' })
      send({
        t: 'page.data',
        page: currentTag,
        source: 'smoke',
        // `SMOKE_HANDOFF_MISSING=1`：故意**不含**新建的那条 —— 让模型校验时发现"没落库"（R3 的重做路径）
        data: HANDOFF_MISSING
          ? { list: [{ id: 2, name: '用户库' }] }
          : { list: [{ id: 1, name: '订单库' }, { id: 2, name: '用户库' }] },
        truncated: false,
        at: Date.now(),
      })
    }
    send({
      t: 'tool.result',
      id: msg.id,
      ok: true,
      data: msg.name === 'render' ? { status: 'done', target: msg.args?.tag } : { status: 'success', value: 'ok' },
    })
    return
  }

  if (msg.t === 'chat.plan') {
    // 人工步骤（`handoff_step` 的产物）：计划卡上出现 `waiting-user` —— 模拟用户点「我已完成，下一步」。
    // 只点一次（真实用户也只点一次）；该步被推进后会带着 `done` 回来，那是权威结果。
    const waiting = msg.steps?.find((step) => step.status === 'waiting-user')
    if (waiting) {
      handoffSeen = true
      if (waiting.issue) {
        // 校验不通过 → 该步被 issue 交回重做：这是 R3 的落点（卡片上会显示"需你重做"+原因）
        reworkSeen = true
        stepIssue = waiting.issue.reason ?? '（有 issue）'
        console.log(`   ↳ 需重做：${waiting.id} ${waiting.title}｜原因：${waiting.issue.reason}`)
        // 只再点一次（避免与真模型无限来回），点完就不再交互
        if (!issueRetrySent) {
          issueRetrySent = true
          send({ t: 'chat.send', text: `我已重做 ${waiting.id}`, planId: msg.planId, stepDoneId: waiting.id })
        }
        return
      }
      console.log(
        `   ↳ 轮到用户操作：${waiting.id} ${waiting.title}｜指引：${waiting.instructions ?? '（无）'}`,
      )
      if (!stepDoneSent) {
        stepDoneSent = true
        send({ t: 'chat.send', text: `我已完成 ${waiting.id}`, planId: msg.planId, stepDoneId: waiting.id })
      }
      return
    }
    if (msg.steps?.some((step) => step.owner === 'user' && step.status === 'done')) userStepDone = true
    // 只要服务端说这张卡还是"待确认"（proposed），脚本就点「开始执行」——
    // 真实用户也会这么做（包括模型中途 re-plan 出来的新计划，不该被脚本晾着）。
    if (msg.status === 'approved') return
    // 修订档：第一张计划卡不确认，先提修改意见（模拟计划卡上的「修改计划」+「提交修改」）；
    // 第二张（修订结果）才确认执行 —— 这样也能顺带验证"修订后门禁解锁"。
    if (EXPECT === 'revise' && !firstPlan) {
      firstPlan = msg
      console.log('   ↳ 首版计划步骤：', msg.steps.map((step) => step.title).join(' / '))
      send({ t: 'chat.send', text: REVISE_TEXT, revisePlanId: msg.planId })
      return
    }
    if (EXPECT === 'revise' && !revisedPlan) {
      revisedPlan = msg
      console.log('   ↳ 修订结果：', msg.note ?? '（无变更摘要）')
    }
    approvedPlanId = msg.planId
    console.log('   ↳ 计划卡步骤：', msg.steps.map((step) => step.title).join(' / '))
    send({ t: 'chat.send', text: '开始执行计划', planId: msg.planId })
    return
  }

  if (msg.t === 'chat.ask') {
    const answer = msg.options?.[0] ?? '第一个'
    console.log('   ↳ 回答问题：', answer)
    send({ t: 'chat.send', text: answer, questionId: msg.questionId })
    return
  }

  if (msg.t === 'chat.done') {
    // 欢迎语也会发一条 chat.done（steps: 0、没有耗时）—— 它不是一轮，不计数
    if (!msg.steps) return
    rounds += 1
    if (rounds >= MAX_ROUNDS) {
      clearTimeout(timer)
      finish(0)
    }
  }
})
