// SessionService 的「回合边界」状态单测（node:test + tsx 直跑 src）。
// 覆盖：模式记录、计划生命周期（提议 / 覆盖 / 批准 / 过期 planId / 进度）、
// 提问生命周期（覆盖旧问题 / 回答匹配 / 重复回答）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentPlan, PendingQuestion } from '@webassistant/protocol'
import { SessionService } from '../src/session/session.service.js'

function makeService(): SessionService {
  return new SessionService()
}

function makePlan(id: string, steps = ['A', 'B']): AgentPlan {
  return {
    id,
    summary: `plan ${id}`,
    steps: steps.map((title, index) => ({ id: `step-${index + 1}`, title, status: 'pending' })),
    status: 'proposed',
    createdAt: Date.now(),
  }
}

function makeQuestion(id: string): PendingQuestion {
  return { id, question: '看哪个？', options: ['张三', '李四'], askedAt: Date.now() }
}

test('setMode / setModeDecision：模式与判定结果落在会话上', () => {
  const svc = makeService()
  const session = svc.create()
  svc.setMode(session, 'plan')
  svc.setModeDecision(session, {
    requested: 'plan',
    effective: 'plan',
    decidedBy: 'user',
    reason: '按你的选择',
  })
  assert.equal(session.mode, 'plan')
  assert.equal(session.modeDecision?.effective, 'plan')
})

test('recordPlan：新计划覆盖旧计划，旧计划被标 superseded（旧 planId 可被识别为过期）', () => {
  const svc = makeService()
  const session = svc.create()
  const first = makePlan('plan-1')
  svc.recordPlan(session, first)
  const second = makePlan('plan-2')
  svc.recordPlan(session, second)
  assert.equal(session.plan?.id, 'plan-2')
  assert.equal(first.status, 'superseded')
  // 用户拿着旧卡片点「开始执行」→ 明确回 stale，而不是错误地批准新计划
  assert.equal(svc.approvePlan(session, 'plan-1'), 'stale')
  assert.equal(session.plan?.approvedAt, undefined)
})

test('approvePlan：命中当前计划才批准；没有计划时回 none', () => {
  const svc = makeService()
  const session = svc.create()
  assert.equal(svc.approvePlan(session, 'plan-1'), 'none')
  svc.recordPlan(session, makePlan('plan-1'))
  assert.equal(svc.approvePlan(session, 'plan-1'), 'approved')
  assert.equal(session.plan?.status, 'approved')
  assert.ok(session.plan?.approvedAt)
})

test('updatePlan：进度更新（不把计划标成 superseded）', () => {
  const svc = makeService()
  const session = svc.create()
  const plan = makePlan('plan-1')
  svc.recordPlan(session, plan)
  svc.approvePlan(session, 'plan-1')
  svc.updatePlan(session, { ...plan, steps: plan.steps.map((s) => ({ ...s, status: 'done' as const })) })
  assert.equal(session.plan?.status, 'approved')
  assert.deepEqual(session.plan?.steps.map((step) => step.status), ['done', 'done'])
  // undefined 不覆盖已有计划（finish_turn 在没有计划时走这条路）
  svc.updatePlan(session, undefined)
  assert.ok(session.plan)
})

test('recordQuestion + answerQuestion：按 questionId 匹配回答', () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordQuestion(session, makeQuestion('q-1'))
  assert.equal(svc.answerQuestion(session, '张三', 'q-1'), true)
  assert.equal(session.pendingQuestion?.answer, '张三')
  assert.ok(session.pendingQuestion?.answeredAt)
})

test('answerQuestion：旧 questionId 不匹配 → false（不误记回答）', () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordQuestion(session, makeQuestion('q-1'))
  assert.equal(svc.answerQuestion(session, '李四', 'q-old'), false)
  assert.equal(session.pendingQuestion?.answeredAt, undefined)
})

test('answerQuestion：用户直接打字（不带 id）也算回答当前问题', () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordQuestion(session, makeQuestion('q-1'))
  assert.equal(svc.answerQuestion(session, '随便说一个'), true)
  assert.equal(session.pendingQuestion?.answer, '随便说一个')
})

test('answerQuestion：已回答过的问题不会被第二次回答覆盖', () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordQuestion(session, makeQuestion('q-1'))
  svc.answerQuestion(session, '张三', 'q-1')
  assert.equal(svc.answerQuestion(session, '李四', 'q-1'), false)
  assert.equal(session.pendingQuestion?.answer, '张三')
})

test('recordQuestion：新问题覆盖旧问题（一次只问一个），没有问题时回答返回 false', () => {
  const svc = makeService()
  const session = svc.create()
  assert.equal(svc.answerQuestion(session, '凭空回答'), false)
  svc.recordQuestion(session, makeQuestion('q-1'))
  svc.recordQuestion(session, makeQuestion('q-2'))
  assert.equal(session.pendingQuestion?.id, 'q-2')
  assert.equal(svc.answerQuestion(session, '答案', 'q-1'), false)
  assert.equal(svc.answerQuestion(session, '答案', 'q-2'), true)
})

test('计划与提问都随会话销毁（连接作用域，不落盘）', () => {
  const svc = makeService()
  const session = svc.create()
  svc.recordPlan(session, makePlan('plan-1'))
  svc.recordQuestion(session, makeQuestion('q-1'))
  svc.destroy(session.id)
  assert.equal(svc.find(session.id), undefined)
})
