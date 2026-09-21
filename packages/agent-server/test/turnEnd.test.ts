// turnEnd 单测（node:test + tsx 直跑 src）。
// 覆盖：三个收尾工具的入参校验（非法输入要抛错 → SDK 会标 isError 让模型自己修正）、
// 产物 → 待推送消息的投影、兜底文本必须被抑制、计划进度推进。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyHandoff,
  applyPlanProgress,
  applyUserStepDone,
  buildPlan,
  buildQuestion,
  describeHandoff,
  describePlanChanges,
  describePlanRevision,
  describeProgress,
  describeStepLabel,
  MAX_HANDOFF_INSTRUCTION,
  MAX_PLAN_STEPS,
  mergePlanRevision,
  normalizeAskArgs,
  normalizeFinishArgs,
  normalizeHandoffArgs,
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

// ───────────── 人工步骤：交接 / 用户推进 / 校验失败重做（add-plan-manual-steps）─────────────

/** 已确认的计划（3 步，第 1 步已完成）—— 交接的典型场景 */
function handedPlan(summary = '保存并核对订单'): ReturnType<typeof buildPlan> {
  const plan = buildPlan({ summary, steps: ['打开订单页', '填好数量', '保存订单'] }, STAMP)
  return {
    ...plan,
    status: 'approved',
    approvedAt: 1,
    steps: [
      { id: 'step-1', title: '打开订单页', status: 'done' },
      { id: 'step-2', title: '填好数量', status: 'pending' },
      { id: 'step-3', title: '保存订单', status: 'pending' },
    ],
  }
}

test('normalizeHandoffArgs：合法的交接 → stepId + instruction（可带 issue）', () => {
  const plan = handedPlan()
  assert.deepEqual(
    normalizeHandoffArgs({ stepId: ' step-3 ', instruction: ' 在订单页点「保存」，看到状态变成已提交 ' }, plan),
    { stepId: 'step-3', instruction: '在订单页点「保存」，看到状态变成已提交' },
  )
  assert.deepEqual(
    normalizeHandoffArgs(
      { stepId: 'step-3', instruction: '改好后点保存', issue: { reason: '订单仍是草稿', expected: '状态为已提交' } },
      plan,
    ),
    {
      stepId: 'step-3',
      instruction: '改好后点保存',
      issue: { reason: '订单仍是草稿', expected: '状态为已提交' },
    },
  )
})

test('normalizeHandoffArgs：只给 expected 不给 reason 不算"校验失败"（当成普通交接）', () => {
  const plan = handedPlan()
  const got = normalizeHandoffArgs(
    { stepId: 'step-3', instruction: '点保存', issue: { reason: '  ', expected: '已提交' } },
    plan,
  )
  assert.equal(got.issue, undefined)
})

test('normalizeHandoffArgs：无计划 / 未确认 / 未知步骤 / 已完成步骤 / 空指引都抛错（模型自行修正）', () => {
  const plan = handedPlan()
  assert.throws(() => normalizeHandoffArgs({ stepId: 'step-3', instruction: '点保存' }, undefined), /没有可交接的计划/)
  assert.throws(
    () => normalizeHandoffArgs({ stepId: 'step-3', instruction: '点保存' }, { ...plan, status: 'superseded' }),
    /没有可交接的计划/,
  )
  // 计划还没确认就交接 = 绕过"等用户确认再执行"的门禁
  assert.throws(
    () =>
      normalizeHandoffArgs(
        { stepId: 'step-3', instruction: '点保存' },
        { ...plan, status: 'proposed', approvedAt: undefined },
      ),
    /还没被用户确认/,
  )
  assert.throws(() => normalizeHandoffArgs({ stepId: 'step-9', instruction: '点保存' }, plan), /不存在的步骤 id/)
  assert.throws(() => normalizeHandoffArgs({ stepId: 'step-1', instruction: '点保存' }, plan), /已经完成/)
  assert.throws(() => normalizeHandoffArgs({ stepId: '', instruction: '点保存' }, plan), /需要 stepId/)
  // 空指引 = 用户只会收到"你去做一下"，必须拒绝
  assert.throws(() => normalizeHandoffArgs({ stepId: 'step-3', instruction: '   ' }, plan), /需要 instruction/)
})

test('normalizeHandoffArgs：已完成（done）的步骤不带 issue 拒绝；带 issue 允许（校验失败退回重做）', () => {
  const plan = handedPlan()
  // step-1 已完成：普通交接没有意义
  assert.throws(() => normalizeHandoffArgs({ stepId: 'step-1', instruction: '点保存' }, plan), /已经完成/)
  // 但"校验发现用户那一步没做成"必须允许 —— 这是 R3 的唯一入口（实测：不允许就到不了纠错路径）
  assert.deepEqual(
    normalizeHandoffArgs(
      { stepId: 'step-1', instruction: '再点一次保存', issue: { reason: '订单仍是草稿' } },
      plan,
    ),
    { stepId: 'step-1', instruction: '再点一次保存', issue: { reason: '订单仍是草稿' } },
  )
  // 带 issue 把它退回 waiting-user：done → waiting-user + 原因
  const back = applyHandoff(
    plan,
    normalizeHandoffArgs(
      {
        stepId: 'step-1',
        instruction: '再点一次保存',
        issue: { reason: '订单仍是草稿', expected: '已提交' },
      },
      plan,
    ),
    7,
  )
  assert.equal(back.steps[0].status, 'waiting-user')
  assert.equal(back.steps[0].owner, 'user')
  assert.deepEqual(back.steps[0].issue, { reason: '订单仍是草稿', expected: '已提交', at: 7 })
})

test('normalizeHandoffArgs：超长指引被截断（不值得为长度失败一整轮）', () => {
  const plan = handedPlan()
  const got = normalizeHandoffArgs({ stepId: 'step-3', instruction: 'x'.repeat(400) }, plan)
  assert.equal(got.instruction.length, MAX_HANDOFF_INSTRUCTION)
})


test('applyHandoff：目标步 waiting-user + owner/instructions；其它等待中的步骤收回 pending', () => {
  const plan = handedPlan()
  const first = applyHandoff(plan, { stepId: 'step-2', instruction: '填好数量' }, 100)
  assert.equal(first.steps[1].status, 'waiting-user')
  assert.equal(first.steps[1].owner, 'user')
  assert.equal(first.steps[1].instructions, '填好数量')
  assert.equal(first.steps[1].issue, undefined)

  // 再交接另一步 → 同一时刻只有一个"等你"
  const second = applyHandoff(first, { stepId: 'step-3', instruction: '点保存' }, 200)
  assert.equal(second.steps[1].status, 'pending')
  assert.equal(second.steps[2].status, 'waiting-user')
  assert.equal(second.steps.filter((step) => step.status === 'waiting-user').length, 1)
  // 不改安装前提（id / 步骤数）
  assert.equal(second.id, plan.id)
  assert.equal(second.steps.length, plan.steps.length)
})

test('applyHandoff：带 issue → 写入原因与期望；不带 issue 会清掉旧 issue', () => {
  const plan = handedPlan()
  const failed = applyHandoff(
    plan,
    { stepId: 'step-3', instruction: '再点一次保存', issue: { reason: '订单仍是草稿', expected: '状态已提交' } },
    300,
  )
  assert.deepEqual(failed.steps[2].issue, { reason: '订单仍是草稿', expected: '状态已提交', at: 300 })

  const again = applyHandoff(failed, { stepId: 'step-3', instruction: '再点一次保存' }, 400)
  assert.equal(again.steps[2].issue, undefined)
  assert.equal(again.steps[2].status, 'waiting-user')
})

test('applyUserStepDone：只认 waiting-user 的步骤；推进后 done 且清 issue', () => {
  const plan = handedPlan()
  const waiting = applyHandoff(
    plan,
    { stepId: 'step-3', instruction: '点保存', issue: { reason: '仍是草稿' } },
    1,
  )
  const result = applyUserStepDone(waiting, 'step-3')
  assert.equal(result?.step.status, 'done')
  assert.equal(result?.step.issue, undefined)
  assert.equal(result?.plan.steps[2].status, 'done')
  assert.equal(result?.plan.steps[2].instructions, '点保存') // 指引留着（历史可见）
  // 不是等待中的步骤（pending / 已推进 / 不存在）一律返回 undefined
  assert.equal(applyUserStepDone(plan, 'step-2'), undefined)
  assert.equal(applyUserStepDone(result!.plan, 'step-3'), undefined)
  assert.equal(applyUserStepDone(plan, 'step-9'), undefined)
})


test('describeStepLabel / describeHandoff：正常交接与"没做成"两套文案都说清下一步动作', () => {
  const plan = handedPlan()
  const waiting = applyHandoff(plan, { stepId: 'step-3', instruction: '在订单页点「保存」' }, 1)
  const step = waiting.steps[2]
  assert.equal(describeStepLabel(waiting, step), '第 3 步「保存订单」')
  const ok = describeHandoff(waiting, step)
  assert.match(ok, /第 3 步「保存订单」需要你在页面上操作：在订单页点「保存」/)
  assert.match(ok, /做完后点「我已完成，下一步」/)

  const failed = applyHandoff(
    waiting,
    { stepId: 'step-3', instruction: '再点一次保存', issue: { reason: '订单仍是草稿', expected: '状态为已提交' } },
    2,
  )
  const text = describeHandoff(failed, failed.steps[2])
  assert.match(text, /看起来没做成：订单仍是草稿；应该做成：状态为已提交/)
  assert.match(text, /点「我已重做，下一步」/)
})

test('projectTurnEnd(handoff_step)：同 planId 的卡片（该步 waiting-user）+ 一条提示；抑制兜底文本', () => {
  const plan = handedPlan()
  const waiting = applyHandoff(plan, { stepId: 'step-3', instruction: '在订单页点「保存」' }, 1)
  const projection = projectTurnEnd({
    tool: 'handoff_step',
    handoff: { plan: waiting, step: waiting.steps[2] },
  })
  assert.equal(projection.endedBy, 'handoff_step')
  assert.equal(projection.suppressFallbackText, true)
  const card = projection.messages[0]
  assert.equal(card.t, 'chat.plan')
  if (card.t === 'chat.plan') {
    assert.equal(card.planId, plan.id) // 交接不改 planId
    assert.equal(card.status, 'approved')
    assert.equal(card.steps[2].status, 'waiting-user')
    assert.equal(card.steps[2].instructions, '在订单页点「保存」')
  }
  const text = projection.messages[1]
  assert.equal(text.t, 'chat.text')
  if (text.t === 'chat.text') assert.match(text.delta, /我已完成，下一步/)
  // 缺产物 = 调用方 bug，不该推进一张空卡
  assert.throws(() => projectTurnEnd({ tool: 'handoff_step' }), /需要 handoff/)
})

test('applyPlanProgress：不能替用户勾掉 waiting-user 的步骤（done 填了也不算、doneAll 也不行）', () => {
  const plan = handedPlan()
  const waiting = applyHandoff(plan, { stepId: 'step-3', instruction: '点保存' }, 1)

  const byDone = applyPlanProgress(waiting, { done: ['step-2', 'step-3'], doneAll: false }, 10)
  assert.equal(byDone?.steps[2].status, 'waiting-user') // 模型填进 done 不生效
  assert.equal(byDone?.steps[1].status, 'done') // 其它步骤照常推进

  const byAll = applyPlanProgress(byDone, { done: [], doneAll: true }, 20)
  assert.equal(byAll?.steps[2].status, 'waiting-user')
  assert.equal(byAll?.status, 'approved') // 还有等待中的步骤 → 计划不能 completed
  assert.equal(byAll?.completedAt, undefined)

  // 用户推进之后，doneAll 才能真正收尾
  const advanced = applyUserStepDone(byAll!, 'step-3')!
  const finished = applyPlanProgress(advanced.plan, { done: [], doneAll: true }, 30)
  assert.equal(finished?.status, 'completed')
  assert.equal(finished?.completedAt, 30)
})

test('mergePlanRevision：命中等待中的步骤保留 owner / instructions / issue；reopen 才清 issue', () => {
  const plan = handedPlan()
  const waiting = applyHandoff(
    plan,
    { stepId: 'step-3', instruction: '点保存', issue: { reason: '仍是草稿', expected: '已提交' } },
    1,
  )
  const kept = mergePlanRevision(
    waiting,
    { summary: plan.summary, steps: [{ id: 'step-3', title: '保存订单（改标题）', reopen: false }] },
    5,
  )
  assert.equal(kept.plan.steps[0].status, 'waiting-user')
  assert.equal(kept.plan.steps[0].owner, 'user')
  assert.equal(kept.plan.steps[0].instructions, '点保存')
  assert.equal(kept.plan.steps[0].issue?.reason, '仍是草稿')

  const reopened = mergePlanRevision(
    waiting,
    { summary: plan.summary, steps: [{ id: 'step-3', title: '保存订单', reopen: true }] },
    6,
  )
  assert.equal(reopened.plan.steps[0].status, 'pending')
  assert.equal(reopened.plan.steps[0].issue, undefined)
})

