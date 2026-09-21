// SessionService 的**计划修订**单测（node:test + tsx 直跑 src）。
//
// 锁的是修订与"重新生成"在会话层面的两条硬差别（`add-interactive-plan-revision`）：
// ① 修订**不换计划**：同一个 planId 原地更新，旧计划不会被标 superseded（卡片不失效）；
// ② 修订后**重新对齐批准状态**：已批准的计划回到 proposed 且 `approvedAt` 被清空 ——
//    plan 门禁判的就是 `approvedAt`，留着它等于"计划改了、门禁还开着"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentPlan } from '@webassistant/protocol'
import { SessionService } from '../src/session/session.service.js'

function makePlan(id: string, steps = ['A', 'B']): AgentPlan {
  return {
    id,
    summary: `plan ${id}`,
    steps: steps.map((title, index) => ({ id: `step-${index + 1}`, title, status: 'pending' })),
    status: 'proposed',
    createdAt: Date.now(),
    revision: 1,
  }
}

/** 模拟 `mergePlanRevision` 的产物：同 id、revision+1、步骤带状态 */
function revised(plan: AgentPlan, steps: AgentPlan['steps']): AgentPlan {
  return { ...plan, steps, revision: (plan.revision ?? 1) + 1, revisedAt: 42 }
}

test('revisePlan：同 planId 原地更新，不标 superseded（旧卡片继续有效）', () => {
  const svc = new SessionService()
  const session = svc.create()
  const plan = makePlan('plan-1')
  svc.recordPlan(session, plan)

  const merged = revised(plan, [
    { id: 'step-1', title: 'A（改）', status: 'done' },
    { id: 'step-2', title: 'B', status: 'pending' },
  ])
  assert.equal(svc.revisePlan(session, 'plan-1', merged), 'revised')
  assert.equal(session.plan?.id, 'plan-1')
  assert.equal(session.plan?.revision, 2)
  assert.equal(session.plan?.steps[0].title, 'A（改）')
  assert.equal(session.plan?.steps[0].status, 'done') // 进度没有被修订清掉
  assert.notEqual(session.plan?.status, 'superseded')
  // 卡片没换 → 用户改完能直接用同一个 planId 批准
  assert.equal(svc.approvePlan(session, 'plan-1'), 'approved')
})

test('revisePlan：已批准的计划被修订后回到 proposed 且清空 approvedAt（门禁重新锁上）', () => {
  const svc = new SessionService()
  const session = svc.create()
  const plan = makePlan('plan-1')
  svc.recordPlan(session, plan)
  assert.equal(svc.approvePlan(session, 'plan-1'), 'approved')
  assert.notEqual(session.plan?.approvedAt, undefined)

  const merged = revised(session.plan!, [
    { id: 'step-1', title: 'A', status: 'pending' },
    { id: 'step-2', title: 'B（改）', status: 'pending' },
  ])
  assert.equal(svc.revisePlan(session, 'plan-1', merged), 'revised')
  assert.equal(session.plan?.status, 'proposed')
  assert.equal(session.plan?.approvedAt, undefined)
})

test('revisePlan：planId 不匹配（过期卡片）不动当前计划；没有计划时回 none', () => {
  const svc = new SessionService()
  const session = svc.create()
  const plan = makePlan('plan-2')
  svc.recordPlan(session, plan)

  const merged = revised(plan, [{ id: 'step-1', title: '不该生效', status: 'pending' }])
  assert.equal(svc.revisePlan(session, 'plan-1', merged), 'stale')
  assert.equal(session.plan?.steps[0].title, 'A') // 当前计划没被改动

  const empty = svc.create()
  assert.equal(svc.revisePlan(empty, 'plan-1', merged), 'none')
})

test('setPlanTurn：修订意图每轮可重置（prompt 与门禁都读它）', () => {
  const svc = new SessionService()
  const session = svc.create()
  svc.setPlanTurn(session, { kind: 'revise', planId: 'plan-1', text: '第 3 步改一下', at: 1 })
  assert.equal(session.planTurn?.planId, 'plan-1')
  assert.equal(session.planTurn?.kind, 'revise')
  svc.setPlanTurn(session, undefined)
  assert.equal(session.planTurn, undefined)
})
