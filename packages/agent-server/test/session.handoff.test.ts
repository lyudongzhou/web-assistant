// SessionService 的**人工步骤**单测（node:test + tsx 直跑 src）。
//
// 锁的是 `add-plan-manual-steps` 的两条服务端保证：
// ① `waiting-user` 的步骤**只能**由用户点「我已完成，下一步」（`completeUserStep`）推进 ——
//    过期 planId / 不是等待中的步骤都不改计划（调用方据此给用户可读提示）；
// ② 本轮的人工步骤回执（`stepTurn`）与修订意图（`planTurn`）一样**每轮重置**，
//    prompt 据此要求模型"先校验再继续"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentPlan } from '@webassistant/protocol'
import { SessionService } from '../src/session/session.service.js'

/** 已确认的计划：第 1 步完成、第 2 步待做、第 3 步已交回用户（waiting-user） */
function waitingPlan(id = 'plan-1'): AgentPlan {
  return {
    id,
    summary: '保存并核对订单',
    steps: [
      { id: 'step-1', title: '打开订单页', status: 'done' },
      { id: 'step-2', title: '填好数量', status: 'pending' },
      {
        id: 'step-3',
        title: '保存订单',
        status: 'waiting-user',
        owner: 'user',
        instructions: '在订单页点「保存」',
        issue: { reason: '订单仍是草稿', expected: '状态为已提交', at: 1 },
      },
    ],
    status: 'approved',
    createdAt: 1,
    revision: 1,
    approvedAt: 1,
  }
}

test('completeUserStep：推进等待中的步骤 → done 且清 issue（指引保留）', () => {
  const svc = new SessionService()
  const session = svc.create()
  svc.recordPlan(session, waitingPlan())

  assert.equal(svc.completeUserStep(session, 'plan-1', 'step-3'), 'done')
  const step = session.plan?.steps[2]
  assert.equal(step?.status, 'done')
  assert.equal(step?.issue, undefined)
  assert.equal(step?.instructions, '在订单页点「保存」') // 指引留着，历史可读
  // 其它步骤不受影响
  assert.equal(session.plan?.steps[0].status, 'done')
  assert.equal(session.plan?.steps[1].status, 'pending')
})

test('completeUserStep：planId 过期（换了计划）回 stale，且不动当前计划', () => {
  const svc = new SessionService()
  const session = svc.create()
  svc.recordPlan(session, waitingPlan('plan-2'))

  assert.equal(svc.completeUserStep(session, 'plan-1', 'step-3'), 'stale')
  assert.equal(session.plan?.steps[2].status, 'waiting-user')
  assert.equal(session.plan?.steps[2].issue?.reason, '订单仍是草稿')
})

test('completeUserStep：不是等待中的步骤回 mismatch（已推进过 / 已被交接成别的步）', () => {
  const svc = new SessionService()
  const session = svc.create()
  svc.recordPlan(session, waitingPlan())

  // pending / done / 不存在 都拒绝
  assert.equal(svc.completeUserStep(session, 'plan-1', 'step-2'), 'mismatch')
  assert.equal(svc.completeUserStep(session, 'plan-1', 'step-1'), 'mismatch')
  assert.equal(svc.completeUserStep(session, 'plan-1', 'step-9'), 'mismatch')
  // 推进过一次后，同一个步骤再来一次也是 mismatch（幂等，不会重复推进）
  assert.equal(svc.completeUserStep(session, 'plan-1', 'step-3'), 'done')
  assert.equal(svc.completeUserStep(session, 'plan-1', 'step-3'), 'mismatch')
})

test('completeUserStep：没有计划回 none（不带 planId 也可推进，但同样要求步骤在等你）', () => {
  const svc = new SessionService()
  const empty = svc.create()
  assert.equal(svc.completeUserStep(empty, 'plan-1', 'step-3'), 'none')

  const session = svc.create()
  svc.recordPlan(session, waitingPlan())
  assert.equal(svc.completeUserStep(session, undefined, 'step-3'), 'done')
})

test('setStepTurn：回执每轮可重置（prompt 要在模型调用工具之前读到它）', () => {
  const svc = new SessionService()
  const session = svc.create()
  svc.setStepTurn(session, { kind: 'step-done', stepId: 'step-3', title: '保存订单', text: '已完成', at: 1 })
  assert.equal(session.stepTurn?.stepId, 'step-3')
  assert.equal(session.stepTurn?.title, '保存订单')
  svc.setStepTurn(session, undefined)
  assert.equal(session.stepTurn, undefined)
})
