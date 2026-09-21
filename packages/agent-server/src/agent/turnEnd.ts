// 「一轮是怎么结束的」→ 推给客户端的消息（纯函数，零依赖）。
//
// 为什么单独一层：收尾工具（`propose_plan` / `revise_plan` / `ask_user` / `finish_turn`，`lifecycle.completesRun`）
// 是"回合边界"的唯一出口，而它们的产物（计划卡 / 问题卡 / 进度文本）与**兜底文本**的取舍
// 极易出错：`completesRun` 会把收尾工具的返回值当作 run 的 `outputText`，若服务端仍按
// 「模型没流式输出就补发 outputText」的老规矩走，用户就会看到一坨 JSON，
// 或者看到与计划卡重复的一段文本。
//
// 所以：**只要本轮是收尾工具结束的，就一律抑制兜底文本**，由本模块决定该推什么消息。
// 与 `traceEvents.ts` / `traceText.ts` 同款分层：可脱离 Nest / SDK / LLM 单测。
import type { AgentPlan, PendingQuestion, PlanStep } from '@webassistant/protocol'
import type {
  AskUserToolArgs,
  ChatAskMessage,
  ChatPlanMessage,
  ChatTextMessage,
  FinishTurnToolArgs,
  HandoffStepToolArgs,
  ProposePlanToolArgs,
  RevisePlanToolArgs,
  ServerMessage,
  TurnEndToolName,
} from '@webassistant/protocol/websocket'

/** 新建计划 / 问题时的 id 与时间注入（保持本模块纯函数，便于单测固定输出） */
export interface TurnEndStamp {
  id: string
  now: number
}

/** 计划步骤条数上限（超过则拒绝该次调用，避免"计划"变成一篇散文） */
export const MAX_PLAN_STEPS = 8

/**
 * 校验并归一化 `propose_plan` 入参。
 * 非法输入**抛错** → SDK 会把工具结果标为 `isError` 并把原因回给模型（模型可自行修正）。
 */
export function normalizePlanArgs(args: ProposePlanToolArgs): { summary: string; steps: string[] } {
  const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
  if (!summary) throw new Error('propose_plan 需要一句 summary（这个计划要达成什么）')
  const rawSteps = Array.isArray(args?.steps) ? args.steps : []
  const titles = rawSteps
    .map((step) => (typeof step?.title === 'string' ? step.title.trim() : ''))
    .filter((title) => title.length > 0)
  if (titles.length === 0) throw new Error('propose_plan 至少需要一个步骤（steps[].title）')
  if (titles.length > MAX_PLAN_STEPS) {
    throw new Error(`propose_plan 最多 ${MAX_PLAN_STEPS} 步；请把任务收敛成更少的阶段`)
  }
  return { summary, steps: titles }
}

/**
 * 校验 `ask_user` 入参：一次一个问题，2~5 个非空选项。
 * 选项数不合格时抛错（spec: 选项数量非法时被拒绝）。
 */
export function normalizeAskArgs(args: AskUserToolArgs): { question: string; options: string[] } {
  const question = typeof args?.question === 'string' ? args.question.trim() : ''
  if (!question) throw new Error('ask_user 需要一个 question')
  const options = (Array.isArray(args?.options) ? args.options : [])
    .map((option) => (typeof option === 'string' ? option.trim() : ''))
    .filter((option) => option.length > 0)
  if (options.length < 2 || options.length > 5) {
    throw new Error('ask_user 需要 2~5 个可选项（用户也可以直接输入文字）')
  }
  return { question, options }
}

/** 校验 `finish_turn` 入参 */
export function normalizeFinishArgs(args: FinishTurnToolArgs): {
  summary: string
  done: string[]
  remaining: string[]
  doneAll: boolean
} {
  const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
  if (!summary) throw new Error('finish_turn 需要一句 summary（这一轮做了什么 / 现在什么状态）')
  const pick = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    )
  return {
    summary,
    done: pick(args?.done),
    remaining: pick(args?.remaining),
    doneAll: args?.doneAll === true,
  }
}

/** 交接指引的长度上限（指引是"在哪点什么"，不是散文；过长直接截断，不值得为此让一整轮失败） */
export const MAX_HANDOFF_INSTRUCTION = 240

/** 交接入参（校验后） */
export interface NormalizedHandoffArgs {
  stepId: string
  instruction: string
  issue?: { reason: string; expected?: string }
}

/**
 * 校验并归一化 `handoff_step` 入参（把计划的某一步**交回用户手做**）。
 *
 * 抛错即"这次交接不成立"（SDK 会把工具结果标成 `isError`，模型自行修正）：
 * - 没有计划 / 计划已过期 / **计划还没被用户确认** → 人工步骤必须挂在当前这份**已确认**的计划上
 *   （没确认就交接，等于绕过"等用户确认再执行"的门禁）；
 * - `stepId` 不在计划里 → 交接一个不存在的步骤，是"界面上什么都没发生"的来源；
 * - 该步已完成（`done`）**且没带 `issue`** → 没有可交接的东西；
 *   **带 `issue` 是例外且必须允许**：用户点过「我已完成」后服务端已经把该步标 `done`，
 *   模型校验发现它其实没做成时，正是要用 `issue` 把它**退回 `waiting-user`** 让用户重做 ——
 *   不允许这一步，R3（纠错提示）在真机上根本走不到（实测踩到过）；
 * - `instruction` 为空 → 用户只会收到"你去做一下"，等于没有提示（本变更要消灭的病症之一）。
 */
export function normalizeHandoffArgs(
  args: HandoffStepToolArgs,
  plan: AgentPlan | undefined,
): NormalizedHandoffArgs {
  if (!plan || plan.status === 'superseded') {
    throw new Error('当前没有可交接的计划；请先调用 propose_plan 并让用户在计划卡上点「开始执行」')
  }
  if (plan.approvedAt == null) {
    throw new Error('计划还没被用户确认（计划卡上还是「计划待确认」）；请让用户点「开始执行」后再交接这一步')
  }
  const stepId = typeof args?.stepId === 'string' ? args.stepId.trim() : ''
  if (!stepId) throw new Error('handoff_step 需要 stepId（当前计划里的步骤 id，如 step-3）')
  const step = plan.steps.find((item) => item.id === stepId)
  if (!step) {
    throw new Error(
      `handoff_step 引用了当前计划里不存在的步骤 id：${stepId}。` +
        `当前计划的步骤：${plan.steps.map((item) => `${item.id}（${item.title}）`).join('、')}`,
    )
  }
  const reason = typeof args?.issue?.reason === 'string' ? args.issue.reason.trim() : ''
  const expected = typeof args?.issue?.expected === 'string' ? args.issue.expected.trim() : ''
  if (step.status === 'done' && !reason) {
    throw new Error(
      `${stepId}「${step.title}」已经完成了，没有要交接的东西。` +
        '若是**校验发现用户刚才那一步没做成**，请带上 issue（reason，可选 expected）把它交回重做。',
    )
  }
  const instruction = (typeof args?.instruction === 'string' ? args.instruction.trim() : '').slice(
    0,
    MAX_HANDOFF_INSTRUCTION,
  )
  if (!instruction) {
    throw new Error(
      'handoff_step 需要 instruction：写清"在哪个页面、点什么、做到什么算完成"' +
        '（例如「在订单页填好数量后点『保存』，看到状态变成『已提交』」）',
    )
  }
  return {
    stepId,
    instruction,
    // 只有 reason 非空才算"校验发现问题"；只给 expected 不给 reason 会被当成一次普通交接
    ...(reason ? { issue: { reason, ...(expected ? { expected } : {}) } } : {}),
  }
}

/**
 * 把交接落到计划上（纯函数，返回新计划，不改入参）。
 *
 * 两条规则：
 * - 目标步 → `waiting-user` + `owner: 'user'` + `instructions`（带 `issue` 时一并写入）；
 * - **至多一个步骤在等你**：其它仍处于 `waiting-user` 的步骤收回 `pending`
 *   （UI 只有一个主按钮、prompt 只有一个待办；"同时等用户做两件事"本轮不支持）。
 */
export function applyHandoff(
  plan: AgentPlan,
  normalized: NormalizedHandoffArgs,
  now: number,
): AgentPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      if (step.id === normalized.stepId) {
        const next: PlanStep = {
          ...step,
          status: 'waiting-user',
          owner: 'user',
          instructions: normalized.instruction,
        }
        // 不带 issue 的交接必须清掉上一次的问题，否则用户会看到"已经改好了"还挂着红字
        if (normalized.issue) next.issue = { ...normalized.issue, at: now }
        else delete next.issue
        return next
      }
      if (step.status === 'waiting-user') return { ...step, status: 'pending' as const }
      return step
    }),
  }
}

/**
 * 用户点「我已完成 / 我已重做，下一步」的落点：把该步标 `done` 并清 `issue`。
 * 不是 `waiting-user` 的步骤返回 `undefined`（调用方据此回"这一步不需要你确认"）——
 * 客户端本地不做这个迁移，状态一律由服务端权威下发（见 `add-plan-manual-steps` D5）。
 */
export function applyUserStepDone(
  plan: AgentPlan,
  stepId: string,
): { plan: AgentPlan; step: PlanStep } | undefined {
  const current = plan.steps.find((step) => step.id === stepId)
  if (!current || current.status !== 'waiting-user') return undefined
  const step: PlanStep = { ...current, status: 'done', owner: 'user' }
  delete step.issue
  return { plan: { ...plan, steps: plan.steps.map((item) => (item.id === stepId ? step : item)) }, step }
}

/** 「第 N 步「标题」」的写法（文案与计划卡口径一致） */
export function describeStepLabel(plan: AgentPlan, step: PlanStep): string {
  const index = plan.steps.findIndex((item) => item.id === step.id)
  return index >= 0 ? `第 ${index + 1} 步「${step.title}」` : `步骤「${step.title}」`
}

/**
 * 交接的整句文案（`chat.text` 用）：正常交接 / 校验失败两套。
 *
 * 两套都必须说清"你现在该做什么"与"做完怎么告诉我" —— 用户唯一的下一步动作就是卡片上那个按钮。
 */
export function describeHandoff(plan: AgentPlan, step: PlanStep): string {
  const label = describeStepLabel(plan, step)
  if (step.issue) {
    const expected = step.issue.expected ? `；应该做成：${step.issue.expected}` : ''
    return (
      `${label}看起来没做成：${step.issue.reason}${expected}。` +
      '请在页面上改好后点「我已重做，下一步」，我再校验一遍。'
    )
  }
  return (
    `${label}需要你在页面上操作：${step.instructions ?? ''}\n` +
    '做完后点「我已完成，下一步」，我接着往下做。'
  )
}

/**
 * 用校验后的入参构造计划（id / 时间由调用方注入）。
 *
 * 步骤只带 `title`（可选 `detail`）：**谁来做这一步**不在这里声明 ——
 * 某一步是否需要用户手做取决于执行到那一步时页面实际能给什么能力（见 `add-plan-manual-steps` D4），
 * `owner` 一律由运行期的 `handoff_step` 写入。
 */
export function buildPlan(
  normalized: { summary: string; steps: string[] },
  stamp: TurnEndStamp,
): AgentPlan {
  const steps: PlanStep[] = normalized.steps.map((title, index) => ({
    id: `step-${index + 1}`,
    title,
    status: 'pending',
  }))
  return {
    id: stamp.id,
    summary: normalized.summary,
    steps,
    status: 'proposed',
    createdAt: stamp.now,
    revision: 1,
  }
}

/** 修订入参（校验后）：`id` 有 = 原地改该步骤，无 = 新增 */
export interface NormalizedReviseArgs {
  note?: string
  summary: string
  steps: Array<{ id?: string; title: string; detail?: string; reopen: boolean }>
}

/**
 * 校验并归一化 `revise_plan` 入参（在当前计划上做**增量修订**）。
 *
 * 三条硬规则（都为了让"用户说了改哪一步"必然生效，见 `add-interactive-plan-revision`）：
 * - 引用了当前计划里**不存在**的 `id` → 抛错（模型最常犯的错是回填错 id；静默忽略会变成
 *   "用户说了改、服务端没改、界面却显示已更新"）；
 * - `steps` 为空 → 抛错；
 * - `summary` 缺省 → 沿用当前计划的 summary（改一步不该顺手把目标也改掉）。
 */
export function normalizeReviseArgs(
  args: RevisePlanToolArgs,
  current: AgentPlan | undefined,
): NormalizedReviseArgs {
  if (!current) {
    throw new Error('当前没有计划可以修改；请先调用 propose_plan 给出计划')
  }
  const rawSteps = Array.isArray(args?.steps) ? args.steps : []
  const steps: NormalizedReviseArgs['steps'] = []
  for (const step of rawSteps) {
    const title = typeof step?.title === 'string' ? step.title.trim() : ''
    if (!title) continue
    const id = typeof step?.id === 'string' ? step.id.trim() : ''
    const detail = typeof step?.detail === 'string' ? step.detail.trim() : ''
    steps.push({
      ...(id ? { id } : {}),
      title,
      ...(detail ? { detail } : {}),
      reopen: step?.reopen === true,
    })
  }
  if (steps.length === 0) throw new Error('revise_plan 至少需要一个步骤（steps[].title）')

  const known = current.steps.map((step) => step.id)
  const unknown = steps.map((step) => step.id).filter((id): id is string => !!id && !known.includes(id))
  if (unknown.length) {
    throw new Error(
      `revise_plan 引用了当前计划里不存在的步骤 id：${unknown.join('、')}。` +
        `只能引用这些 id：${known.join('、')}；新增的步骤不要带 id。`,
    )
  }

  const summaryArg = typeof args?.summary === 'string' ? args.summary.trim() : ''
  const noteArg = typeof args?.note === 'string' ? args.note.trim() : ''
  return {
    ...(noteArg ? { note: noteArg } : {}),
    summary: summaryArg || current.summary,
    steps,
  }
}

/** 一次修订的变更明细（用于生成用户可见的摘要，也是单测的断言对象） */
export interface PlanChanges {
  /** 新增的步骤数 */
  added: number
  /** 被改动的既有步骤（标题用于展示；改动含标题 / 详情变化） */
  changed: Array<{ id: string; title: string }>
  /** 被移除的既有步骤标题 */
  removed: string[]
  /** 其中原本已完成的步骤数（用于提示"进度被丢掉"这类异常，见 design 的 Risks） */
  removedDone: number
  /** 被重新打开的已完成步骤标题（`reopen: true`） */
  reopened: string[]
  /** 原样保留（既没改标题也没改详情）的步骤数 */
  kept: number
}

export interface PlanRevision {
  plan: AgentPlan
  changes: PlanChanges
}

/** `step-N` 里最大的 N（新增步骤从它继续编号，保证不与既有 id 冲突） */
function maxStepIndex(steps: PlanStep[]): number {
  let max = 0
  for (const step of steps) {
    const matched = /^step-(\d+)$/.exec(step.id)
    if (matched) max = Math.max(max, Number(matched[1]))
  }
  return max
}

/**
 * 按 `step.id` 把修订入参合并进当前计划（纯函数，返回新计划 —— 不改入参）。
 *
 * 合并规则（spec: 修订按步骤标识增量合并）：
 * - 命中 id → 就地改（**保留状态**，除非 `reopen` 把它置回 `pending`）；
 * - 无 id → 新增（分配下一个空闲 `step-N`，状态 `pending`）；
 * - 当前计划里未出现的步骤 → 移除（移除的已完成步骤会被记进 `changes.removedDone`）；
 * - 顺序以入参为准（重排由此自然支持）。
 *
 * `plan.id` **不变**（这是"改计划"，不是"换计划"）；`revision + 1`、`revisedAt = now`。
 * 批准状态不在这里处理：由 `session.revisePlan` 负责回落（已批准的计划被改动即回到 `proposed`）。
 */
export function mergePlanRevision(
  plan: AgentPlan,
  normalized: NormalizedReviseArgs,
  now: number,
): PlanRevision {
  const existing = new Map(plan.steps.map((step) => [step.id, step]))
  const changed: PlanChanges['changed'] = []
  const reopened: string[] = []
  let added = 0
  let kept = 0
  let nextIndex = maxStepIndex(plan.steps)

  const steps: PlanStep[] = normalized.steps.map((step) => {
    if (!step.id) {
      added += 1
      nextIndex += 1
      return {
        id: `step-${nextIndex}`,
        title: step.title,
        ...(step.detail ? { detail: step.detail } : {}),
        status: 'pending' as const,
      }
    }
    const previous = existing.get(step.id)
    if (!previous) {
      // normalizeReviseArgs 已保证不会走到这里；防御性抛错，避免静默生成"半份计划"
      throw new Error(`mergePlanRevision: 未知步骤 id ${step.id}`)
    }
    existing.delete(step.id)
    const titleChanged = previous.title !== step.title
    const detailChanged = (previous.detail ?? '') !== (step.detail ?? '')
    if (titleChanged || detailChanged) changed.push({ id: step.id, title: step.title })
    else kept += 1
    if (step.reopen && previous.status === 'done') reopened.push(step.title)
    const next: PlanStep = {
      id: step.id,
      title: step.title,
      ...(step.detail ? { detail: step.detail } : {}),
      status: step.reopen ? ('pending' as const) : previous.status,
    }
    // 人工步骤的"归属 / 指引 / 问题"是这一步的语义，改标题不该把它们丢掉；
    // `reopen: true`（重做这一步）时清掉问题 —— 否则"重新打开"了却还挂着上一次的红字
    if (previous.owner) next.owner = previous.owner
    if (previous.instructions) next.instructions = previous.instructions
    if (!step.reopen && previous.issue) next.issue = previous.issue
    return next
  })

  // 合并**之后**才校验上限：既约束入参，也约束"旧步骤 + 新步骤"的总量
  if (steps.length > MAX_PLAN_STEPS) {
    throw new Error(`修订后的计划最多 ${MAX_PLAN_STEPS} 步（当前 ${steps.length} 步）；请把任务收敛成更少的阶段`)
  }

  const removed = [...existing.values()]
  return {
    plan: {
      ...plan,
      summary: normalized.summary,
      steps,
      revision: (plan.revision ?? 1) + 1,
      revisedAt: now,
    },
    changes: {
      added,
      changed,
      removed: removed.map((step) => step.title),
      removedDone: removed.filter((step) => step.status === 'done').length,
      reopened,
      kept,
    },
  }
}

/** 结构化变更摘要（进 `chat.plan.note`，也拼进助手文本） */
export function describePlanChanges(changes: PlanChanges): string {
  const parts: string[] = []
  if (changes.changed.length) {
    parts.push(`修改 ${changes.changed.length} 步（${changes.changed.map((c) => c.title).join('、')}）`)
  }
  if (changes.added) parts.push(`新增 ${changes.added} 步`)
  if (changes.reopened.length) {
    parts.push(`重新打开 ${changes.reopened.length} 个已完成步骤（${changes.reopened.join('、')}）`)
  }
  if (changes.removed.length) {
    const doneNote = changes.removedDone ? `，其中 ${changes.removedDone} 个已完成` : ''
    parts.push(`移除 ${changes.removed.length} 个步骤（${changes.removed.join('、')}${doneNote}）`)
  }
  return parts.length ? parts.join('；') : '计划内容未变化'
}

/** 面向用户的整句（`chat.text` 用）：模型的说明 + 结构化摘要 */
export function describePlanRevision(changes: PlanChanges, note?: string): string {
  const detail = describePlanChanges(changes)
  const head = note?.trim() ? `已按你的要求更新计划：${note.trim()}` : '已更新计划'
  return `${head}（${detail}）`
}

/** 用校验后的入参构造待回答问题 */
export function buildQuestion(
  normalized: { question: string; options: string[] },
  stamp: TurnEndStamp,
): PendingQuestion {
  return {
    id: stamp.id,
    question: normalized.question,
    options: normalized.options,
    askedAt: stamp.now,
  }
}

export interface TurnEndProjection {
  /** 按顺序推给客户端的消息 */
  messages: ServerMessage[]
  /**
   * 是否抑制 agent.service 的兜底文本（`result.outputText`）。
   * 收尾工具一律抑制：计划 / 问题有结构化消息，进度有本模块生成的文本，再补发一次只会重复；
   * 而 `finish_turn` 的 outputText 是**对象**，直接推出去用户看不懂。
   */
  suppressFallbackText: boolean
  endedBy: TurnEndToolName
  /** 面向用户的一句话（气泡 / 卡片副标题备选） */
  text: string
}

/** 进度文案：把「第 N/M 步」说清楚，并告诉用户下一步怎么走 */
export function describeProgress(input: {
  summary: string
  doneCount: number
  total: number
  doneAll: boolean
}): string {
  if (input.doneAll) return input.summary
  const head = input.total > 0 ? `已推进到第 ${input.doneCount}/${input.total} 步：` : '本轮进度：'
  return `${head}${input.summary}\n（还有未完成的步骤，回复「继续」我接着做）`
}

/**
 * 卡片上的计划状态（服务端权威值，客户端只跟随）。
 *
 * 为什么只看 `approvedAt`：门禁判据就是它（`hooks.beforeTool`），卡片显示"待确认/执行中"必须与
 * 门禁的真实状态一致；而**修订会把它清空**（已批准的计划被改动 → 回到待确认），
 * 所以这张卡的显示会与"模型能不能动页面"天然同步。
 */
export function planCardStatus(plan: AgentPlan): ChatPlanMessage['status'] {
  return plan.approvedAt != null ? 'approved' : 'proposed'
}

/**
 * 把收尾工具的产物投影成待推送消息。
 * `plan` / `question` 由调用方（`agent.service`）先落进 session 再传进来 —— 本函数不改状态。
 */
export function projectTurnEnd(input: {
  tool: TurnEndToolName
  /** `propose_plan` / `revise_plan`：落库后的计划 */
  plan?: AgentPlan
  /** `revise_plan`：本次修订的变更明细 */
  changes?: PlanChanges
  /** `revise_plan`：模型自述的修改说明（拼进助手文本；卡片副标题用服务端生成的结构化摘要） */
  note?: string
  /** `handoff_step`：落库后的计划与该步骤（`status: 'waiting-user'`） */
  handoff?: { plan: AgentPlan; step: PlanStep }
  /** `ask_user`：落库后的待回答问题 */
  question?: PendingQuestion
  /** `finish_turn`：校验后的入参 */
  finish?: { summary: string; done: string[]; remaining: string[]; doneAll: boolean }
  /** `finish_turn`：更新后的计划进度 */
  progress?: { doneCount: number; total: number }
}): TurnEndProjection {
  if (input.tool === 'propose_plan') {
    if (!input.plan) throw new Error('projectTurnEnd: propose_plan 需要 plan')
    const message: ChatPlanMessage = {
      t: 'chat.plan',
      planId: input.plan.id,
      summary: input.plan.summary,
      steps: input.plan.steps,
      createdAt: input.plan.createdAt,
      status: planCardStatus(input.plan),
      revision: input.plan.revision ?? 1,
    }
    return {
      messages: [message],
      suppressFallbackText: true,
      endedBy: input.tool,
      text: `这是执行计划：${input.plan.summary}`,
    }
  }

  if (input.tool === 'revise_plan') {
    if (!input.plan) throw new Error('projectTurnEnd: revise_plan 需要 plan')
    if (!input.changes) throw new Error('projectTurnEnd: revise_plan 需要 changes')
    const note = describePlanChanges(input.changes)
    const text = describePlanRevision(input.changes, input.note)
    const message: ChatPlanMessage = {
      t: 'chat.plan',
      // planId 不变：卡片在原位更新，而不是"旧卡作废 + 冒出一张新卡"
      planId: input.plan.id,
      summary: input.plan.summary,
      steps: input.plan.steps,
      createdAt: input.plan.createdAt,
      status: planCardStatus(input.plan),
      revision: input.plan.revision ?? 1,
      ...(input.plan.revisedAt != null ? { revisedAt: input.plan.revisedAt } : {}),
      note,
    }
    return {
      // 卡片 + 一句变更摘要：只发卡片的话，用户看不出"到底改了哪里"
      messages: [message, { t: 'chat.text', delta: text, channel: 'text' }],
      suppressFallbackText: true,
      endedBy: input.tool,
      text,
    }
  }

  if (input.tool === 'handoff_step') {
    if (!input.handoff) throw new Error('projectTurnEnd: handoff_step 需要 handoff（plan + step）')
    const { plan, step } = input.handoff
    const text = describeHandoff(plan, step)
    const message: ChatPlanMessage = {
      t: 'chat.plan',
      // 交接同样不改 planId：卡片原地更新，用户看到"这一步轮到我"而不是"换了一份计划"
      planId: plan.id,
      summary: plan.summary,
      steps: plan.steps,
      createdAt: plan.createdAt,
      status: planCardStatus(plan),
      revision: plan.revision ?? 1,
      ...(plan.revisedAt != null ? { revisedAt: plan.revisedAt } : {}),
    }
    return {
      // 卡片 + 一句提示：只发卡片的话，用户不知道要做什么、做完点哪里
      messages: [message, { t: 'chat.text', delta: text, channel: 'text' }],
      suppressFallbackText: true,
      endedBy: input.tool,
      text,
    }
  }

  if (input.tool === 'ask_user') {
    if (!input.question) throw new Error('projectTurnEnd: ask_user 需要 question')
    const message: ChatAskMessage = {
      t: 'chat.ask',
      questionId: input.question.id,
      question: input.question.question,
      options: input.question.options,
      askedAt: input.question.askedAt,
    }
    return {
      messages: [message],
      suppressFallbackText: true,
      endedBy: input.tool,
      text: input.question.question,
    }
  }

  if (!input.finish) throw new Error('projectTurnEnd: finish_turn 需要 finish 入参')
  const text = describeProgress({
    summary: input.finish.summary,
    doneCount: input.progress?.doneCount ?? 0,
    total: input.progress?.total ?? 0,
    doneAll: input.finish.doneAll,
  })
  const message: ChatTextMessage = { t: 'chat.text', delta: text, channel: 'text' }
  return {
    messages: [message],
    suppressFallbackText: true,
    endedBy: input.tool,
    text,
  }
}

/**
 * 按 `finish_turn` 的 `done` / `doneAll` 更新计划步骤状态（纯函数，返回新计划）。
 * `done` 里出现但当前计划没有的 id 直接忽略（模型可能记错），不报错 —— 收尾路径不能失败。
 *
 * **人工步骤是例外**（`add-plan-manual-steps`）：`waiting-user` 的步骤**只能**由用户点
 * 「我已完成，下一步」（`chat.send.stepDoneId`）推进 —— 模型把它的 id 填进 `done`、
 * 或置 `doneAll: true`，都不生效；计划也不会因此在仍有等待中的步骤时变成 `completed`。
 * 这条是**服务端保证**："不许自己假设用户做完了"不能只靠 prompt。
 */
export function applyPlanProgress(
  plan: AgentPlan | undefined,
  finish: { done: string[]; doneAll: boolean },
  now: number,
): AgentPlan | undefined {
  if (!plan) return undefined
  const doneIds = new Set(finish.done)
  const steps = plan.steps.map((step) => {
    if (step.status === 'waiting-user') return step
    return finish.doneAll || doneIds.has(step.id) ? { ...step, status: 'done' as const } : step
  })
  const allDone = steps.every((step) => step.status === 'done')
  const completed = allDone
  return {
    ...plan,
    steps,
    status: completed ? 'completed' : plan.status,
    ...(completed ? { completedAt: now } : {}),
  }
}

/** 计划进度统计（`describeProgress` 用） */
export function planProgress(plan: AgentPlan | undefined): { doneCount: number; total: number } {
  const steps = plan?.steps ?? []
  return {
    doneCount: steps.filter((step) => step.status === 'done').length,
    total: steps.length,
  }
}
