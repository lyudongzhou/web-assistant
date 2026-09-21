// turnState 纯逻辑单测：模式条覆盖、计划卡的 proposed→approved 迁移（含过期 planId）、
// 问题卡的覆盖与回答（含"用户直接打字不带 id"这条服务端同款语义）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MODE_OPTIONS,
  answerAskCard,
  applyAsk,
  applyMode,
  applyPlan,
  approvePlanCard,
  beginPlanRevision,
  cancelPlanRevision,
  createTurnState,
  describeMode,
  pendingQuestionId,
  settlePlanRevision,
  submitPlanRevision,
  updatePlanDraft,
} from '../src/lib/turnState.ts'

const modeMsg = (overrides = {}) => ({
  t: 'chat.mode',
  requested: 'auto',
  effective: 'act',
  decidedBy: 'heuristic',
  reason: '单页操作，参数齐全',
  ...overrides,
})

const planMsg = (overrides = {}) => ({
  t: 'chat.plan',
  planId: 'plan-1',
  summary: '对比三张数据源',
  steps: [
    { id: 'step-1', title: '打开数据源页', status: 'pending' },
    { id: 'step-2', title: '逐个查看配置', status: 'pending' },
  ],
  createdAt: 1,
  ...overrides,
})

const askMsg = (overrides = {}) => ({
  t: 'chat.ask',
  questionId: 'q-1',
  question: '要看哪个用户？',
  options: ['张三', '李四'],
  askedAt: 1,
  ...overrides,
})

test('初始状态：三块都为空（没有模式判定 / 计划 / 提问）', () => {
  const state = createTurnState()
  assert.equal(state.mode, null)
  assert.equal(state.plan, null)
  assert.equal(state.ask, null)
  assert.equal(pendingQuestionId(state), undefined)
})

test('applyMode：每轮覆盖（状态行显示最新判定）', () => {
  let state = createTurnState()
  state = applyMode(state, modeMsg())
  state = applyMode(state, modeMsg({ effective: 'plan', decidedBy: 'model' }))
  assert.equal(state.mode?.effective, 'plan')
  assert.equal(describeMode(state.mode), '计划模式 · 模型自选')
  assert.equal(describeMode(null), '')
})

test('applyPlan：新计划回到 proposed（旧卡被覆盖）', () => {
  let state = createTurnState()
  state = applyPlan(state, planMsg())
  assert.equal(state.plan?.status, 'proposed')
  state = approvePlanCard(state, 'plan-1')
  assert.equal(state.plan?.status, 'approved')
  // 新计划（重新规划）覆盖 -> 又回到待确认
  state = applyPlan(state, planMsg({ planId: 'plan-2' }))
  assert.equal(state.plan?.message.planId, 'plan-2')
  assert.equal(state.plan?.status, 'proposed')
})

test('approvePlanCard：planId 不匹配（过期卡片）不动状态', () => {
  let state = applyPlan(createTurnState(), planMsg({ planId: 'plan-2' }))
  state = approvePlanCard(state, 'plan-1')
  assert.equal(state.plan?.status, 'proposed')
  // 没有计划时也不抛
  assert.equal(approvePlanCard(createTurnState(), 'plan-1').plan, null)
})

test('applyAsk + pendingQuestionId：未回答时给出 questionId（send 据此带回）', () => {
  const state = applyAsk(createTurnState(), askMsg())
  assert.equal(pendingQuestionId(state), 'q-1')
  assert.equal(state.ask?.answer, undefined)
})

test('answerAskCard：按 questionId 匹配；缺省 id（用户直接打字）也算回答', () => {
  const state = applyAsk(createTurnState(), askMsg())
  // 旧 id 不匹配 -> 不动
  assert.equal(answerAskCard(state, '李四', 'q-old').ask?.answer, undefined)
  // 匹配 -> 记录
  assert.equal(answerAskCard(state, '张三', 'q-1').ask?.answer, '张三')
  // 不带 id -> 也算回答当前问题（与服务端 answerQuestion 同款语义）
  assert.equal(answerAskCard(state, '随便说一个').ask?.answer, '随便说一个')
})

test('answerAskCard：已回答后不再改，且 pendingQuestionId 变为空', () => {
  let state = applyAsk(createTurnState(), askMsg())
  state = answerAskCard(state, '张三', 'q-1')
  state = answerAskCard(state, '李四', 'q-1')
  assert.equal(state.ask?.answer, '张三')
  assert.equal(pendingQuestionId(state), undefined)
})

test('applyAsk：新问题覆盖旧问题（一次只问一个）', () => {
  let state = applyAsk(createTurnState(), askMsg())
  state = answerAskCard(state, '张三', 'q-1')
  state = applyAsk(state, askMsg({ questionId: 'q-2', question: '要看哪个订单？' }))
  assert.equal(state.ask?.message.questionId, 'q-2')
  assert.equal(state.ask?.answer, undefined)
  assert.equal(pendingQuestionId(state), 'q-2')
})

test('MODE_OPTIONS：三档齐全且含 auto（交给服务端判定）', () => {
  assert.deepEqual(MODE_OPTIONS.map((option) => option.value), ['auto', 'act', 'plan'])
  assert.ok(MODE_OPTIONS.every((option) => option.label && option.hint))
})

// ───────── 交互式计划修订（add-interactive-plan-revision）─────────
//
// 客户端这一侧要保证两件事：① 卡片**跟随服务端权威状态**（修订会让已批准的计划回落成待确认，
// 本地不能自己推）；② 「修改计划」的草稿/提交态可迁移、可收尾（不然按钮会卡在"修改中"）。

test('applyPlan：跟随服务端 status（修订回落 covered：approved → proposed 也照做）', () => {
  let state = applyPlan(createTurnState(), planMsg({ status: 'proposed', revision: 1 }))
  assert.equal(state.plan?.status, 'proposed')
  // 用户点「开始执行」→ 本地先转 approved（即时反馈）
  state = approvePlanCard(state, 'plan-1')
  assert.equal(state.plan?.status, 'approved')
  // 服务端在修订后把计划回落成待确认：同 planId、revision+1、带变更摘要 —— 本地必须跟随
  state = applyPlan(
    state,
    planMsg({ status: 'proposed', revision: 2, note: '修改 1 步（导出 CSV）', revisedAt: 42 }),
  )
  assert.equal(state.plan?.status, 'proposed')
  assert.equal(state.plan?.message.revision, 2)
  assert.equal(state.plan?.message.note, '修改 1 步（导出 CSV）')
  assert.equal(state.plan?.message.planId, 'plan-1', '修订不改 planId（卡片原地更新）')
})

test('applyPlan：status 缺省时回落 proposed（兼容没有该字段的来源）', () => {
  const state = applyPlan(createTurnState(), planMsg())
  assert.equal(state.plan?.status, 'proposed')
})

test('修订草稿态：展开 → 输入 → 提交即收起输入 → 收到新卡片后停在可操作态', () => {
  let state = applyPlan(createTurnState(), planMsg({ status: 'proposed' }))
  assert.equal(state.plan?.draft, undefined)

  state = beginPlanRevision(state, 'plan-1')
  assert.equal(state.plan?.draft, '') // 展开 = 草稿存在且为空
  state = updatePlanDraft(state, '第 2 步改成导出 CSV')
  assert.equal(state.plan?.draft, '第 2 步改成导出 CSV')

  state = submitPlanRevision(state, 'plan-1')
  assert.equal(state.plan?.revising, true)
  // 提交即收起：草稿消失 ⇒ 组件里的 editing 为 false ⇒ 卡片回到按钮行（显示"正在更新计划…"）
  assert.equal(state.plan?.draft, undefined, '提交后应收起输入框（否则会一直停在提交界面）')

  // 服务端推回修订后的卡片（同 planId）→ 退出"修改中"，且不把输入框重新打开
  state = applyPlan(state, planMsg({ status: 'proposed', revision: 2 }))
  assert.equal(state.plan?.revising, false)
  assert.equal(state.plan?.draft, undefined, '修订结果回来后应是「开始执行 / 修改计划」界面')
})

test('applyPlan：服务端推来新卡片一律收起输入框（即使没走 submit）', () => {
  // 例如用户展开输入框后直接点了别处 / 上一轮的自然结束路径也能推来卡片
  let state = applyPlan(createTurnState(), planMsg({ status: 'proposed' }))
  state = beginPlanRevision(state, 'plan-1')
  state = updatePlanDraft(state, '写了一半')
  assert.equal(state.plan?.draft, '写了一半')
  state = applyPlan(state, planMsg({ status: 'proposed', revision: 2 }))
  assert.equal(state.plan?.draft, undefined)
  assert.equal(state.plan?.revising, false)
})

test('修订草稿态：取消丢弃草稿；planId 不匹配（过期卡片）一律不动', () => {
  let state = applyPlan(createTurnState(), planMsg({ status: 'proposed' }))
  state = beginPlanRevision(state, 'plan-1')
  state = updatePlanDraft(state, '想改点别的')
  state = cancelPlanRevision(state)
  assert.equal(state.plan?.draft, undefined)
  assert.equal(state.plan?.revising, false)

  // 过期卡片：点了不该影响当前状态
  const expired = beginPlanRevision(state, 'plan-old')
  assert.deepEqual(expired, state)
  assert.equal(submitPlanRevision(state, 'plan-old').plan?.revising, false)
  // 没有草稿时输入变化不生效（没展开就不存在草稿）
  assert.deepEqual(updatePlanDraft(state, 'x'), state)
})

test('settlePlanRevision：本轮失败也要退出"修改中"（否则按钮永远卡住）', () => {
  let state = applyPlan(createTurnState(), planMsg({ status: 'proposed' }))
  state = beginPlanRevision(state, 'plan-1')
  state = updatePlanDraft(state, '第 2 步改一下')
  state = submitPlanRevision(state, 'plan-1')
  assert.equal(state.plan?.revising, true)
  state = settlePlanRevision(state)
  assert.equal(state.plan?.revising, false)
  // 失败后卡片同样是可操作态（用户写的那句话已经在对话里，可再点「修改计划」重试）
  assert.equal(state.plan?.draft, undefined)
  assert.equal(state.plan?.status, 'proposed')
  // 已经是 false 时是同一引用（不做无意义的更新）
  assert.equal(settlePlanRevision(state), state)
})

test('applyPlan：换一份新计划（重新生成）时丢弃本地草稿', () => {
  let state = applyPlan(createTurnState(), planMsg({ status: 'proposed' }))
  state = beginPlanRevision(state, 'plan-1')
  state = updatePlanDraft(state, '草稿')
  state = applyPlan(state, planMsg({ planId: 'plan-2', status: 'proposed' }))
  assert.equal(state.plan?.message.planId, 'plan-2')
  assert.equal(state.plan?.draft, undefined)
  assert.equal(state.plan?.revising, false)
})

// 面板折叠不再放这里：它是"面板"的纯视图状态，与过程区共用 `usePanelOpen`
// （见 test/usePanelOpen.test.mjs）—— 状态机只保留"回合边界"相关的卡片状态。
