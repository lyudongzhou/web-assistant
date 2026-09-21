// 「思考过程」与「结果」的分流纯逻辑。
//
// 为什么单独一层：这两类内容此前被 `appendAssistant` 拼进**同一条** ChatMessage 的同一个
// `content` 字符串（过程行 + 结果文字），UI 只拿到一根字符串 —— 没有任何字段可区分，
// 于是界面上必然糊在一起（"思考的过程与结果没有区分的开"）。
// 分流 / 配对 / 合并的规则收敛在这里，可单测（不拉起 vue），与 lib/activities.ts 同款。
//
// 四类内容：
//   - 结果（kind: 'message'）：用户真正要看的答复 → 渲染成气泡
//   - 思考（kind: 'reasoning'）：模型的 reasoning 增量 → 渲染进过程区
//   - 过程（kind: 'step'）：agent 的工具步骤（开始 / 结算）→ 渲染进过程区
//   - 错误（kind: 'error'）：run 级失败 → 渲染进过程区（不污染结果气泡）
import type { AgentStepMessage } from '@webassistant/protocol/websocket'
import type { WcActivity } from '@webassistant/wc-runtime-vue/host'
import type { ChatMessage, ChatMessageKind } from '../types.js'

/** 流式通道：结果正文 / 模型思考。两者各自维护游标，互不串行。 */
export type StreamChannel = Extract<ChatMessageKind, 'message' | 'reasoning'>

/** 过程区默认最多渲染多少条 */
export const TRACE_VISIBLE_LIMIT = 60

/**
 * step 与 runtime activity 配对的时间窗（ms）。
 *
 * 两者由**不同路径**产生 —— step 走 ws 消息、activity 走进程内活动总线（`activityBus`）——
 * 时间戳不可能严格相等，也不保证先后；没有窗口就永远配不上，同一步会在过程区出现两行。
 */
export const TRACE_MERGE_WINDOW_MS = 1_500

/**
 * 追加一段流式文本。
 *
 * 关键点：**游标按通道各自持有**，且只有「游标指向的那条正好是同通道」时才续写。
 * 这样 `text → step → text` 的交错（多 iteration）不会把结果正文拼进步骤行里 ——
 * 与 `docs/agent-session.md` §10「每个 agent.step 单独成条」的既定 UX 一致。
 *
 * @returns 新的游标（供下一次调用；`-1` 表示这段流还没开始）
 */
export function appendStream(
  messages: ChatMessage[],
  cursor: number,
  channel: StreamChannel,
  delta: string,
  at: number = Date.now(),
): number {
  const current = cursor >= 0 ? messages[cursor] : undefined
  if (!current || current.kind !== channel) {
    messages.push({ role: 'assistant', content: delta, kind: channel, at })
    return messages.length - 1
  }
  current.content += delta
  return cursor
}

/**
 * 过程步骤：`phase: 'start'` 建一行，`phase: 'end'` **就地结算那一行**（不新增）。
 *
 * 为什么回找而不是按 index：SDK 的 `iteration` 在并行工具调用下会重复，且 `toolCallId` 没进协议
 * （不必为 UI 暴露内部 id）。用「同 tool + 同 target + 最近未结算」回找足够稳。
 * 找不到可配对的 start（丢包 / 中途接入）时**退化成一条已结算的步骤** —— 宁可样式不完美，不可丢信息。
 */
export function pushStep(
  messages: ChatMessage[],
  step: AgentStepMessage,
  at: number = Date.now(),
): void {
  const tool = step.tool ?? undefined
  const target = step.target ?? undefined

  if (step.phase !== 'end') {
    messages.push({
      role: 'assistant',
      content: step.text,
      kind: 'step',
      at,
      tool,
      target,
      args: step.args,
      settled: false,
    })
    return
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate.kind !== 'step' || candidate.settled !== false) continue
    if (candidate.tool !== tool) continue
    if ((candidate.target ?? '') !== (target ?? '')) continue
    candidate.settled = true
    candidate.ok = step.ok ?? true
    // 结算文案优先（server 的 end 文案是权威）；空串则保留开始时的文案
    if (step.text) candidate.content = step.text
    if (step.error) candidate.error = step.error
    if (step.durationMs !== undefined) candidate.durationMs = step.durationMs
    return
  }

  messages.push({
    role: 'assistant',
    content: step.text,
    kind: 'step',
    at,
    tool,
    target,
    settled: true,
    ok: step.ok ?? true,
    ...(step.error ? { error: step.error } : {}),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
  })
}

/** 过程 / 结果两栏的切分结果 */
export interface ChatTraceSplit {
  /** 结果气泡（用户真正要看的答复）—— 只含 `kind` 缺省或 `'message'` */
  bubbles: ChatMessage[]
  /** 过程条目（步骤 / 思考 / 错误），按发生顺序 */
  trace: ChatMessage[]
}

/**
 * 按语义切成「过程」与「结果」两栏。
 *
 * `kind` 缺省一律算**结果气泡** —— 老宿主自造的 `ChatMessage`（不带 kind）不能被当成过程藏起来，
 * 这是 `kind?:` 选填的兼容承诺。
 */
export function splitMessages(messages: readonly ChatMessage[]): ChatTraceSplit {
  const bubbles: ChatMessage[] = []
  const trace: ChatMessage[] = []
  for (const message of messages) {
    if (message.kind === undefined || message.kind === 'message') bubbles.push(message)
    else trace.push(message)
  }
  return { bubbles, trace }
}

/** 过程区折叠标题的摘要 */
export interface TraceSummary {
  /** agent 工具步骤数（不含思考 / 错误条目） */
  stepCount: number
  /** 未结算（还在跑）的步骤数 */
  running: number
  /** 失败的步骤数 */
  failed: number
  /** 本轮总耗时（来自 `chat.done.durationMs`；缺省则不显示） */
  durationMs?: number
}

export function summarizeTrace(trace: readonly ChatMessage[], durationMs?: number): TraceSummary {
  let stepCount = 0
  let running = 0
  let failed = 0
  for (const message of trace) {
    if (message.kind !== 'step') continue
    stepCount += 1
    if (message.settled === false) running += 1
    if (message.ok === false) failed += 1
  }
  return { stepCount, running, failed, ...(durationMs === undefined ? {} : { durationMs }) }
}

/**
 * 耗时展示：< 1s 用毫秒，否则用秒（一位小数）。
 * 标题里的「共 N 步 · 8.2s」与每一行的耗时共用同一口径。
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

/** 一条时间轴条目：agent 步骤与 runtime 活动合并后的统一形状 */
export interface TimelineItem {
  key: string
  at: number
  source: 'step' | 'activity'
  /** step 用工具名；activity 用 `WcActivity.kind` */
  kind: string
  /** 展示文案 */
  text: string
  target?: string
  ok?: boolean
  running?: boolean
  durationMs?: number
  error?: string
  /** step 的工具实参（没有 runtime 活动可配对时，详情只能靠它） */
  args?: unknown
  /** runtime 活动的原始记录（args / result 摘要由 UI 复用 formatActivityDetail） */
  activity?: WcActivity
}

/** agent 工具步骤 ↔ runtime 活动 的对应关系（配对去重的前提） */
const STEP_ACTIVITY_KIND: Record<string, WcActivity['kind']> = {
  render: 'navigate',
  call_page_method: 'call',
}

/**
 * 把 agent 步骤与 runtime 活动合成**一条**时间轴（按时间正序）。
 *
 * 为什么必须去重：同一个动作会被两处记录 ——
 *   `agent.step`「正在调用 当前页.setKeyword()」与 runtime 侧 `call` 活动（`origin: 'agent'`，
 *   带 args / 返回值 / 耗时）—— 直接拼接会让同一步显示两行，用户以为是操作了两次。
 *
 * 配对规则：工具名 → activity.kind（render→navigate、call_page_method→call）
 * + 时间窗 `TRACE_MERGE_WINDOW_MS`。`call` 额外要求 `origin === 'agent'` ——
 * 否则会把页面自己调的 refresh 之类混进来（那是页面行为，不是 agent 那一步）。
 *
 * `wait_for_observation` **不参与配对**：它没有对应的 runtime 活动，而页面自己上报的 `data`
 * 活动是页面行为，合并进去会造成「agent 在等 → 显示别人上报的数据」的错配。
 *
 * 配对不上的一律保留 —— 宁可多一行，不可丢掉一条"真发生过"的动作。
 */
export function mergeTimeline(
  steps: readonly ChatMessage[],
  activities: readonly WcActivity[] = [],
): TimelineItem[] {
  const items: TimelineItem[] = []
  const consumed = new Set<WcActivity>()

  for (const step of steps) {
    if (step.kind !== 'step') continue
    const at = step.at ?? 0
    const partner = findPartner(step, activities, consumed)
    if (partner) consumed.add(partner)
    items.push({
      key: `step:${at}:${step.tool ?? ''}:${step.target ?? ''}`,
      at,
      source: 'step',
      kind: step.tool ?? 'step',
      text: step.content,
      target: step.target,
      ok: step.ok,
      running: step.settled === false,
      // 耗时优先取 activity 的（覆盖真实执行区间），step 的作为兜底
      durationMs: partner?.durationMs ?? step.durationMs,
      error: step.error ?? partner?.error,
      args: step.args,
      ...(partner ? { activity: partner } : {}),
    })
  }

  for (const activity of activities) {
    if (consumed.has(activity)) continue
    items.push({
      key: `activity:${activity.at}:${activity.kind}:${activity.name ?? ''}`,
      at: activity.at,
      source: 'activity',
      kind: activity.kind,
      text: activityText(activity),
      target: activity.tag ?? activity.name,
      ok: activity.ok,
      durationMs: activity.durationMs,
      error: activity.error,
      activity,
    })
  }

  return items.sort((a, b) => a.at - b.at)
}

/** 为一条 step 找它对应的 runtime 活动（同 kind + 时间窗内最近的一条） */
function findPartner(
  step: ChatMessage,
  activities: readonly WcActivity[],
  consumed: Set<WcActivity>,
): WcActivity | undefined {
  if (!step.tool) return undefined
  const kind = STEP_ACTIVITY_KIND[step.tool]
  if (!kind) return undefined
  const at = step.at ?? 0
  let best: WcActivity | undefined
  for (const activity of activities) {
    if (consumed.has(activity) || activity.kind !== kind) continue
    // 只有 call 带 origin；agent 亲自调的那次才与 call_page_method 那一步同源
    if (kind === 'call' && activity.origin !== 'agent') continue
    if (Math.abs(activity.at - at) > TRACE_MERGE_WINDOW_MS) continue
    if (!best || Math.abs(activity.at - at) < Math.abs(best.at - at)) best = activity
  }
  return best
}

/** 没有 step 可配对的 runtime 活动 → 一行人话 */
function activityText(activity: WcActivity): string {
  const tag = activity.tag ? ` <${activity.tag}>` : ''
  switch (activity.kind) {
    case 'call':
      return `调用 ${activity.name ?? '?'}()`
    case 'navigate':
      return `页面导航${activity.name ? ` ${activity.name}` : ''}`
    case 'emit':
      return `页面事件${activity.name ? ` ${activity.name}` : ''}`
    case 'data':
      return `数据上报${activity.name ? ` ${activity.name}` : ''}`
    case 'exposed':
      return `能力上报${tag}`
    case 'error':
      return `错误：${activity.error ?? activity.name ?? '未知'}`
    default:
      return `${activity.kind}${activity.name ? ` ${activity.name}` : ''}`
  }
}


/** 过程区的一行：合并后的时间轴条目 / 思考块 / 错误块 */
export type TraceRow =
  | { type: 'item'; at: number; key: string; item: TimelineItem }
  | { type: 'reasoning'; at: number; key: string; text: string }
  | { type: 'error'; at: number; key: string; text: string }

/**
 * 组装过程区的展示行（按时间正序）。
 *
 * - `step` 与 runtime activity 合并去重（`mergeTimeline`）→ 带状态点的步骤行
 * - `reasoning` / `error` 各自成块 —— 它们的呈现方式与步骤行不同（思考是灰色斜体正文、
 *   错误是红色块），塞进同一种行里会又变成"糊在一起"
 * - 只保留**最近** `limit` 行：过程区空间宝贵，早期步骤的价值远低于"现在在干什么"
 */
export function buildTraceRows(
  trace: readonly ChatMessage[],
  activities: readonly WcActivity[] = [],
  limit: number = TRACE_VISIBLE_LIMIT,
): TraceRow[] {
  const rows: TraceRow[] = mergeTimeline(
    trace.filter((message) => message.kind === 'step'),
    activities,
  ).map((item) => ({ type: 'item' as const, at: item.at, key: item.key, item }))

  trace.forEach((message, index) => {
    if (message.kind !== 'reasoning' && message.kind !== 'error') return
    rows.push({
      type: message.kind,
      at: message.at ?? 0,
      key: `${message.kind}:${index}`,
      text: message.content,
    })
  })

  rows.sort((a, b) => a.at - b.at)
  return rows.length > limit ? rows.slice(rows.length - limit) : rows
}

