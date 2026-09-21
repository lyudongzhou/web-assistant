// turnEnd 单测（node:test + tsx 直跑 src）。
// 覆盖：三个收尾工具的入参校验（非法输入要抛错 → SDK 会标 isError 让模型自己修正）、
// 产物 → 待推送消息的投影、兜底文本必须被抑制、计划进度推进。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPlanProgress,
  buildPlan,
  buildQuestion,
  describePlanChanges,
  describePlanRevision,
  describeProgress,
  MAX_PLAN_STEPS,
  mergePlanRevision,
  normalizeAskArgs,
  normalizeFinishArgs,
  normalizePlanArgs,
  normalizeReviseArgs,
  planCardStatus,
  planProgress,
  projectTurnEnd,
} from '../src/agent/turnEnd.js'

const STAMP = { id: 'plan-1', now: 1_700_000_000_000 }

test('normalizePlanArgs：正常入参 → summary + 步骤标题；空标题被丢弃', () => {
  const got = normalizePlanArgs({
    summary: ' 对比数据源 ',
    steps: [{ title: '打开数据源页' }, { title: '   ' }, { title: '逐个查看配置' }],
  })
  assert.deepEqual(got, { summary: '对比数据源', steps: ['打开数据源页', '逐个查看配置'] })
})

test('normalizePlanArgs：缺 summary / 无步骤 / 步骤过多都抛错（模型会收到 isError 并自行修正）', () => {
  assert.throws(() => normalizePlanArgs({ summary: '', steps: [{ title: 'a' }] }), /summary/)
  assert.throws(() => normalizePlanArgs({ summary: 's', steps: [] }), /至少需要一个步骤/)
  assert.throws(
    () =>
      normalizePlanArgs({
        summary: 's',
        steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({ title: `step ${i}` })),
      }),
    /最多 8 步/,
  )
})

test('normalizeAskArgs：选项数必须是 2~5（1 个或 6 个都拒绝）', () => {
  assert.deepEqual(normalizeAskArgs({ question: ' 看哪个用户？ ', options: ['张三', ' 李四 '] }), {
    question: '看哪个用户？',
    options: ['张三', '李四'],
  })
  assert.throws(() => normalizeAskArgs({ question: 'q', options: ['只有一个'] }), /2~5/)
  assert.throws(
    () => normalizeAskArgs({ question: 'q', options: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    /2~5/,
  )
  assert.throws(() => normalizeAskArgs({ question: '', options: ['a', 'b'] }), /question/)
})

test('normalizeFinishArgs：summary 必填，done/remaining 做类型过滤', () => {
  assert.deepEqual(
    normalizeFinishArgs({ summary: '打开列表', done: ['step-1', 2 as unknown as string], doneAll: false }),
    { summary: '打开列表', done: ['step-1'], remaining: [], doneAll: false },
  )
  assert.throws(() => normalizeFinishArgs({ summary: '  ' }), /summary/)
})

test('buildPlan：步骤 id 稳定（step-1…step-N）且初始状态是 pending', () => {
  const plan = buildPlan({ summary: 'S', steps: ['A', 'B'] }, STAMP)
  assert.deepEqual(plan.steps.map((step) => [step.id, step.status]), [
    ['step-1', 'pending'],
    ['step-2', 'pending'],
  ])
  assert.equal(plan.id, 'plan-1')
  assert.equal(plan.status, 'proposed')
  assert.equal(plan.approvedAt, undefined)
  // 首版：revision = 1（修订后递增，卡片据此显示「第 N 版」）
  assert.equal(plan.revision, 1)
})

test('projectTurnEnd(propose_plan)：推 chat.plan（含服务端权威 status 与版本）、抑制兜底文本', () => {
  const plan = buildPlan({ summary: 'S', steps: ['A'] }, STAMP)
  const projection = projectTurnEnd({ tool: 'propose_plan', plan })
  assert.equal(projection.suppressFallbackText, true)
  assert.equal(projection.endedBy, 'propose_plan')
  assert.deepEqual(projection.messages, [
    {
      t: 'chat.plan',
      planId: 'plan-1',
      summary: 'S',
      steps: plan.steps,
      createdAt: STAMP.now,
      status: 'proposed',
      revision: 1,
    },
  ])
})

test('projectTurnEnd(ask_user)：推 chat.ask、抑制兜底文本', () => {
  const question = buildQuestion({ question: '看哪个？', options: ['张三', '李四'] }, { id: 'q-1', now: 1 })
  const projection = projectTurnEnd({ tool: 'ask_user', question })
  assert.equal(projection.suppressFallbackText, true)
  assert.equal(projection.endedBy, 'ask_user')
  assert.deepEqual(projection.messages, [
    { t: 'chat.ask', questionId: 'q-1', question: '看哪个？', options: ['张三', '李四'], askedAt: 1 },
  ])
})

test('projectTurnEnd(finish_turn)：推进度文本（含第 N/M 步与"回复继续"），并抑制兜底文本', () => {
  const projection = projectTurnEnd({
    tool: 'finish_turn',
    finish: { summary: '已打开数据源页', done: ['step-1'], remaining: ['step-2'], doneAll: false },
    progress: { doneCount: 1, total: 2 },
  })
  assert.equal(projection.suppressFallbackText, true)
  assert.equal(projection.endedBy, 'finish_turn')
  const message = projection.messages[0]
  assert.equal(message.t, 'chat.text')
  if (message.t === 'chat.text') {
    assert.match(message.delta, /第 1\/2 步/)
    assert.match(message.delta, /继续/)
  }
})

test('projectTurnEnd：缺关键产物时抛错（调用方 bug 不该静默产出一张空卡片）', () => {
  assert.throws(() => projectTurnEnd({ tool: 'propose_plan' }), /需要 plan/)
  assert.throws(() => projectTurnEnd({ tool: 'ask_user' }), /需要 question/)
  assert.throws(() => projectTurnEnd({ tool: 'finish_turn' }), /需要 finish/)
})

test('describeProgress：全部完成时不再提示"继续"', () => {
  assert.equal(describeProgress({ summary: '干完了', doneCount: 2, total: 2, doneAll: true }), '干完了')
  assert.match(describeProgress({ summary: '部分', doneCount: 0, total: 0, doneAll: false }), /本轮进度/)
})

test('applyPlanProgress：按 done 勾选、全部勾完自动 completed；未知 id 忽略', () => {
  const plan = buildPlan({ summary: 'S', steps: ['A', 'B'] }, STAMP)
  const halfway = applyPlanProgress(plan, { done: ['step-1', 'step-404'], doneAll: false }, 42)
  assert.deepEqual(halfway?.steps.map((step) => step.status), ['done', 'pending'])
  assert.equal(halfway?.status, 'proposed')
  assert.equal(halfway?.completedAt, undefined)

  const done = applyPlanProgress(plan, { done: [], doneAll: true }, 42)
  assert.deepEqual(done?.steps.map((step) => step.status), ['done', 'done'])
  assert.equal(done?.status, 'completed')
  assert.equal(done?.completedAt, 42)
  // 原计划不被就地改写（纯函数）
  assert.deepEqual(plan.steps.map((step) => step.status), ['pending', 'pending'])
})

test('planProgress：没有计划时是 0/0（进度文案据此退回"本轮进度"）', () => {
  assert.deepEqual(planProgress(undefined), { doneCount: 0, total: 0 })
})

// ───────── 交互式计划修订（add-interactive-plan-revision）─────────
//
// 这一组锁的是"改计划 ≠ 换计划"：按 step id 增量合并，未改动的步骤**保 id、保状态**，
// 这样"用户说了改第 3 步"不会把已完成的进度清掉。

/** 造一份"第 1 步已完成"的计划（进度就从这里被保住或丢掉） */
function progressPlan(): ReturnType<typeof buildPlan> {
  const plan = buildPlan({ summary: '对比三张数据源', steps: ['打开数据源页', '逐个查看配置', '汇总结论'] }, STAMP)
  return {
    ...plan,
    steps: plan.steps.map((step, index) => (index === 0 ? { ...step, status: 'done' as const } : step)),
  }
}

test('normalizeReviseArgs：summary 缺省沿用当前计划；note 去空白；空标题步骤被丢弃', () => {
  const plan = progressPlan()
  const got = normalizeReviseArgs(
    { note: '  改了第 3 步  ', steps: [{ id: 'step-3', title: ' 导出 CSV 对比 ' }, { title: '   ' }] },
    plan,
  )
  assert.deepEqual(got, {
    note: '改了第 3 步',
    summary: '对比三张数据源',
    steps: [{ id: 'step-3', title: '导出 CSV 对比', reopen: false }],
  })
})

test('normalizeReviseArgs：没有计划 / 空 steps / 引用不存在的 step id 都抛错（模型据此自纠）', () => {
  const plan = progressPlan()
  assert.throws(() => normalizeReviseArgs({ steps: [{ title: 'A' }] }, undefined), /没有计划/)
  assert.throws(() => normalizeReviseArgs({ steps: [] }, plan), /至少需要一个步骤/)
  // 引用错 id 是最常见的模型失误：必须显式失败，否则会变成"用户说了改、计划却没变"
  assert.throws(
    () => normalizeReviseArgs({ steps: [{ id: 'step-9', title: 'A' }] }, plan),
    /不存在的步骤 id：step-9/,
  )
})

test('mergePlanRevision：未改动的步骤保 id 保状态（进度不丢）；planId 不变、revision+1', () => {
  const plan = progressPlan()
  const normalized = normalizeReviseArgs(
    {
      steps: [
        { id: 'step-1', title: '打开数据源页' },
        { id: 'step-2', title: '逐个查看配置' },
        { id: 'step-3', title: '导出 CSV 对比' },
      ],
    },
    plan,
  )
  const { plan: revised, changes } = mergePlanRevision(plan, normalized, 42)

  assert.equal(revised.id, plan.id) // 改计划不是换计划
  assert.equal(revised.revision, 2)
  assert.equal(revised.revisedAt, 42)
  assert.deepEqual(
    revised.steps.map((step) => [step.id, step.status]),
    [
      ['step-1', 'done'], // 已完成的进度被保住（这正是旧的"重新规划"会丢掉的）
      ['step-2', 'pending'],
      ['step-3', 'pending'],
    ],
  )
  assert.equal(revised.steps[2].title, '导出 CSV 对比')
  assert.deepEqual(changes.changed, [{ id: 'step-3', title: '导出 CSV 对比' }])
  assert.equal(changes.kept, 2)
  assert.equal(changes.added, 0)
  // 原计划不被就地改写（纯函数）
  assert.equal(plan.steps[2].title, '汇总结论')
  assert.equal(plan.revision, 1)
})

test('mergePlanRevision：新增步骤取新的稳定 id（不与既有冲突）并插在入参给定的位置', () => {
  const plan = progressPlan()
  const normalized = normalizeReviseArgs(
    {
      steps: [
        { id: 'step-1', title: '打开数据源页' },
        { title: '同步结果给张三' },
        { id: 'step-2', title: '逐个查看配置' },
        { id: 'step-3', title: '汇总结论' },
      ],
    },
    plan,
  )
  const { plan: revised, changes } = mergePlanRevision(plan, normalized, 42)
  assert.deepEqual(
    revised.steps.map((step) => step.id),
    ['step-1', 'step-4', 'step-2', 'step-3'],
  )
  assert.equal(revised.steps[1].status, 'pending')
  assert.equal(changes.added, 1)
  assert.equal(changes.changed.length, 0)
  assert.equal(changes.kept, 3)
})

test('mergePlanRevision：入参里没出现的步骤被移除，且移除的已完成步骤会被点名（不静默丢进度）', () => {
  const plan = progressPlan()
  const normalized = normalizeReviseArgs(
    { steps: [{ id: 'step-2', title: '逐个查看配置' }, { id: 'step-3', title: '汇总结论' }] },
    plan,
  )
  const { changes } = mergePlanRevision(plan, normalized, 42)
  assert.deepEqual(changes.removed, ['打开数据源页'])
  assert.equal(changes.removedDone, 1)
  assert.match(describePlanChanges(changes), /移除 1 个步骤（打开数据源页，其中 1 个已完成）/)
})

test('mergePlanRevision：reopen 把已完成的步骤重新打开（其余步骤状态不动）', () => {
  const plan = progressPlan()
  const normalized = normalizeReviseArgs(
    {
      steps: [
        { id: 'step-1', title: '重新打开数据源页', reopen: true },
        { id: 'step-2', title: '逐个查看配置' },
        { id: 'step-3', title: '汇总结论' },
      ],
    },
    plan,
  )
  const { plan: revised, changes } = mergePlanRevision(plan, normalized, 42)
  assert.equal(revised.steps[0].status, 'pending')
  assert.equal(revised.steps[1].status, 'pending')
  assert.deepEqual(changes.reopened, ['重新打开数据源页'])
})

test('mergePlanRevision：合并**之后**仍受步骤上限约束（旧步骤 + 新步骤一起算）', () => {
  const plan = progressPlan()
  const steps = [
    ...plan.steps.map((step) => ({ id: step.id, title: step.title })),
    ...Array.from({ length: MAX_PLAN_STEPS }, (_, index) => ({ title: `新增 ${index}` })),
  ]
  const normalized = normalizeReviseArgs({ steps }, plan)
  assert.throws(() => mergePlanRevision(plan, normalized, 42), /最多 8 步/)
})

test('describePlanChanges / describePlanRevision：没有实质变更时也有可读文案', () => {
  const empty = { added: 0, changed: [], removed: [], removedDone: 0, reopened: [], kept: 3 }
  assert.equal(describePlanChanges(empty), '计划内容未变化')
  assert.equal(
    describePlanRevision({ ...empty, added: 1, changed: [{ id: 'step-3', title: '导出 CSV' }] }, '按你的要求改了'),
    '已按你的要求更新计划：按你的要求改了（修改 1 步（导出 CSV）；新增 1 步）',
  )
})

test('projectTurnEnd(revise_plan)：推同一张卡（同 planId + revision + 变更摘要）+ 一句变更说明', () => {
  const plan = progressPlan()
  const normalized = normalizeReviseArgs(
    {
      note: '第 3 步改成导出',
      steps: [
        { id: 'step-1', title: '打开数据源页' },
        { id: 'step-2', title: '逐个查看配置' },
        { id: 'step-3', title: '导出 CSV 对比' },
      ],
    },
    plan,
  )
  const { plan: revised, changes } = mergePlanRevision(plan, normalized, 42)
  const projection = projectTurnEnd({ tool: 'revise_plan', plan: revised, changes, note: normalized.note })

  assert.equal(projection.suppressFallbackText, true)
  assert.equal(projection.endedBy, 'revise_plan')
  assert.equal(projection.messages.length, 2)
  const card = projection.messages[0]
  assert.equal(card.t, 'chat.plan')
  if (card.t === 'chat.plan') {
    assert.equal(card.planId, plan.id) // 卡片原地更新，而不是"旧卡作废 + 新卡"
    assert.equal(card.revision, 2)
    assert.equal(card.status, 'proposed')
    assert.equal(card.revisedAt, 42)
    assert.equal(card.note, '修改 1 步（导出 CSV 对比）')
    assert.deepEqual(card.steps.map((step) => step.id), ['step-1', 'step-2', 'step-3'])
  }
  const text = projection.messages[1]
  assert.equal(text.t, 'chat.text')
  if (text.t === 'chat.text') assert.match(text.delta, /已按你的要求更新计划：第 3 步改成导出/)
})

test('projectTurnEnd(revise_plan)：缺 plan / changes 时抛错（调用方 bug 不该推进一张空卡）', () => {
  const plan = progressPlan()
  assert.throws(() => projectTurnEnd({ tool: 'revise_plan' }), /需要 plan/)
  assert.throws(() => projectTurnEnd({ tool: 'revise_plan', plan }), /需要 changes/)
})

test('planCardStatus：已批准的计划卡片显示 approved；修订清掉 approvedAt 后回到 proposed', () => {
  const plan = progressPlan()
  assert.equal(planCardStatus(plan), 'proposed')
  assert.equal(planCardStatus({ ...plan, approvedAt: 1 }), 'approved')
  // 修订把 approvedAt 清掉（session.revisePlan 负责）→ 卡片与门禁同时回到"待确认"
  assert.equal(planCardStatus({ ...plan, status: 'proposed', approvedAt: undefined }), 'proposed')
})
