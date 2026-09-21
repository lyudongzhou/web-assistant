// agent.service 的两个纯判定函数单测（node:test + tsx 直跑 src）。
//
// 为什么值得单独测：这两处决定了用户看到的是「红色错误」还是「已暂停」，以及
// 会话结束时是 `completed` 还是 `waiting-plan/waiting-user` —— 都是**只在真实 LLM 调用
// 打满步数时**才会走到的分支，人工几乎无法稳定复现，必须靠单测锁住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beforeToolGate, isBudgetExhausted, resolveRunStatus } from '../src/agent/agent.service.js'
import type { TurnEndProjection } from '../src/agent/turnEnd.js'

const turnEnd = (endedBy: TurnEndProjection['endedBy']): TurnEndProjection => ({
  messages: [],
  suppressFallbackText: true,
  endedBy,
  text: 'x',
})

test('isBudgetExhausted：SDK 的步数上限异常被识别为「暂停」而非失败', () => {
  assert.equal(
    isBudgetExhausted({
      status: 'failed',
      error: new Error('Agent runtime exceeded maxIterations (12)'),
    }),
    true,
  )
  // 其它失败原因不算
  assert.equal(isBudgetExhausted({ status: 'failed', error: new Error('401 unauthorized') }), false)
  assert.equal(isBudgetExhausted({ status: 'failed' }), false)
  assert.equal(isBudgetExhausted({ status: 'completed' }), false)
})

test('resolveRunStatus：收尾工具决定 waiting 状态', () => {
  assert.equal(resolveRunStatus({ status: 'completed' }, undefined, false), 'completed')
  assert.equal(resolveRunStatus({ status: 'completed' }, turnEnd('finish_turn'), false), 'completed')
  assert.equal(resolveRunStatus({ status: 'completed' }, turnEnd('propose_plan'), false), 'waiting-plan')
  // 修订后同样停在"等用户确认计划"（改了计划要重新确认，见 add-interactive-plan-revision）
  assert.equal(resolveRunStatus({ status: 'completed' }, turnEnd('revise_plan'), false), 'waiting-plan')
  assert.equal(resolveRunStatus({ status: 'completed' }, turnEnd('ask_user'), false), 'waiting-user')
})

test('resolveRunStatus：步数用尽算 completed（暂停），其它失败才是 failed；abort 是 cancelled', () => {
  assert.equal(resolveRunStatus({ status: 'failed' }, undefined, true), 'completed')
  assert.equal(resolveRunStatus({ status: 'failed' }, undefined, false), 'failed')
  assert.equal(resolveRunStatus({ status: 'aborted' }, undefined, false), 'cancelled')
})

test('beforeToolGate：修订轮拦掉 propose_plan（"改计划"不许退化成"换计划"）', () => {
  // 修订轮 + propose_plan → 拦，且 reason 指引改用 revise_plan
  const blocked = beforeToolGate({
    toolName: 'propose_plan',
    revisingPlan: true,
    effectiveMode: 'plan',
    planApproved: false,
    planGate: 'hard',
  })
  assert.equal(blocked?.skip, true)
  assert.match(blocked?.reason ?? '', /revise_plan/)
  // 与门禁档位无关：`PLAN_GATE=off` 也照拦（这是修订语义，不是可降级的提示）
  assert.equal(
    beforeToolGate({
      toolName: 'propose_plan',
      revisingPlan: true,
      effectiveMode: 'act',
      planApproved: true,
      planGate: 'off',
    })?.skip,
    true,
  )
  // 非修订轮的 propose_plan 照常放行
  assert.equal(
    beforeToolGate({
      toolName: 'propose_plan',
      revisingPlan: false,
      effectiveMode: 'plan',
      planApproved: false,
      planGate: 'hard',
    }),
    undefined,
  )
})

test('beforeToolGate：plan 模式下未确认计划时拦 render / call_page_method（不拦 wait / 收尾工具）', () => {
  const base = { revisingPlan: false, effectiveMode: 'plan' as const, planApproved: false, planGate: 'hard' as const }
  assert.equal(beforeToolGate({ ...base, toolName: 'render' })?.skip, true)
  assert.equal(beforeToolGate({ ...base, toolName: 'call_page_method' })?.skip, true)
  assert.equal(beforeToolGate({ ...base, toolName: 'wait_for_observation' }), undefined)
  assert.equal(beforeToolGate({ ...base, toolName: 'finish_turn' }), undefined)
  // 已确认 → 放行；act 模式 → 不拦；PLAN_GATE=off → 不拦
  assert.equal(beforeToolGate({ ...base, toolName: 'render', planApproved: true }), undefined)
  assert.equal(beforeToolGate({ ...base, toolName: 'render', effectiveMode: 'act' }), undefined)
  assert.equal(beforeToolGate({ ...base, toolName: 'render', planGate: 'off' }), undefined)
})
