// 模式判定（纯函数，零依赖）。
//
// 为什么这一层单独存在：**SDK 的 `mode`（act/plan/search/yolo）只决定内置工具集是否装载**
// （`@cline/core` 的 `S1` 模式表管的是 read_files/bash/editor/skills/ask_question 那些），
// 而本项目只装载自己的三个工具（render / wait_for_observation / call_page_method），
// 传 `mode` 没有任何效果 —— 所以"模式"必须由我们自己判、自己落地：
//   ① `prepareTurn` 注入的规则集 ② `hooks.beforeTool` 的服务端门禁 ③ 回合推进策略。
//
// 判定顺序（"显式 > 启发式 > 模型自判"）：
//   1. 客户端显式给了 `act` / `plan` → 采用（`decidedBy: 'user'`），**不再做任何猜测**。
//   2. `auto`：启发式（多步信号 / 跨页 / 缺参）能定则定（`decidedBy: 'heuristic'`）。
//   3. 启发式不确定 → 采用**计划倾向**（`plan` + `PLAN_HINT`），由模型在第一轮自选工具，
//      `decidedBy: 'model'`。选错时代的代价只是"多出一张计划卡"，不会造成误操作
//      （服务端门禁 / 硬约束兜底）。
//
// 抽成纯函数的收益：判定规则可以脱离 LLM / Nest / WS 单测，改词表时不会顺手改坏行为。

import type {
  AgentMode,
  EffectiveMode,
  ModeDecidedBy,
  ModeDecision,
} from '@webassistant/protocol'

/** 判定时只看 manifest 页面的这几项（避免依赖整个 ManifestPage 形状） */
export interface ModePageHint {
  tag: string
  title?: string
  keywords?: string[]
  exampleQueries?: string[]
  /** 必填路径参数个数（>0 且用户没给值时，不足以判为"单页直做"） */
  requiredParamCount?: number
}

export interface ResolveModeInput {
  /** 客户端本轮显式请求的模式（`chat.send.mode`）；缺省表示沿用会话模式 */
  requested?: AgentMode
  /** 会话当前模式（上一轮的请求值）；两者都缺省时用 `MODE_DEFAULT` */
  sessionMode?: AgentMode
  /** 本轮用户输入 */
  text: string
  /** manifest 页面清单（用于"命中单一页面"判定） */
  pages?: readonly ModePageHint[]
}

/**
 * 多步 / 多目标信号词。
 *
 * 设计取舍：**宁可漏判也不误判** —— 只有出现明确的"并列 / 顺序 / 汇总"意图才判 `plan`，
 * 其余一律交给模型自判（层 3）。把简单任务误判成计划会让用户多一次点击，比漏判更伤体验。
 */
export const MULTI_STEP_PATTERNS: readonly RegExp[] = [
  /并且|同时|另外|以及|还有/, // 并列目标
  /然后|接着|之后|随后|依次|逐个|一个一个/, // 顺序推进
  /先.{0,12}再|首先.{0,20}其次/, // 显式两步
  /对比|比较|差异|汇总|总结|统计|报表|报告/, // 需要汇总的分析型任务
  /所有|全部|每个|各个|批量|遍历/, // 集合级操作
]

/** 判定理由（面向用户，随 `chat.mode` 下发） */
export const MODE_REASONS = {
  explicit: '按你的选择',
  multiStep: '检测到多步 / 多目标描述',
  multiPage: '涉及多个页面',
  singlePage: '单页操作，参数齐全',
  uncertain: '无法判定，交由模型决定（倾向先出计划）',
} as const

/**
 * 层 3 的提示：`auto` 且启发式不确定时写进系统提示。
 * 一句话让模型自己选"直接干 / 先出计划"，而不是替它猜。
 */
export const PLAN_HINT =
  '本轮模式未定：如果这个任务简单（1~2 步就能完成、参数齐全），直接操作页面；' +
  '如果需要多步、跨多个页面或信息不足，先调用 propose_plan 给出计划（或在无法确定必要信息时调用 ask_user 提问）。'

/** 命中的多步信号（导出给单测与调试日志用） */
export function matchMultiStepSignal(text: string): string | undefined {
  for (const pattern of MULTI_STEP_PATTERNS) {
    const hit = text.match(pattern)
    if (hit) return hit[0]
  }
  return undefined
}

/**
 * 命中的页面（按 tag / title / keywords / exampleQueries 的包含关系，**不过滤强弱**）。
 * 只做包含匹配 —— 词表与文案由 analyzer（含 AI）产出，这里不重复做语义理解。
 * 需要"哪一页更像目标"时用 `candidatePages()`。
 */
export function matchPages(text: string, pages: readonly ModePageHint[] = []): ModePageHint[] {
  const lowered = text.toLowerCase()
  return pages.filter((page) => pageNeedles(page).some((needle) => lowered.includes(needle)))
}

/** 页面的匹配线索（tag / title / keywords / exampleQueries；太短的词不参与，避免"用户"命中一切） */
function pageNeedles(page: ModePageHint): string[] {
  return [page.tag, page.title, ...(page.keywords ?? []), ...(page.exampleQueries ?? [])]
    .filter((item): item is string => typeof item === 'string' && item.length > 1)
    .map((item) => item.toLowerCase())
}

/**
 * 单页命中强度：**tag(3) > title(2) > 关键词 / 示例(1)**。
 *
 * 为什么需要分层：真实 manifest 里页面关键词高度重叠（`user-list` 与 `user-detail` 都可能带
 * "用户"），只按"命中数量"判会把「打开用户列表」这种单页请求判成跨页多步任务，
 * 于是每次简单请求都弹一张计划卡 —— 这正是要避免的误判。
 */
export function scorePage(text: string, page: ModePageHint): number {
  const lowered = text.toLowerCase()
  if (page.tag && lowered.includes(page.tag.toLowerCase())) return 3
  if (page.title && page.title.length > 1 && lowered.includes(page.title.toLowerCase())) return 2
  return pageNeedles(page).some((needle) => lowered.includes(needle)) ? 1 : 0
}

/** 最高分的候选页面（并列最高分都算候选；用于判断"跨页 / 单页"） */
export function candidatePages(text: string, pages: readonly ModePageHint[] = []): ModePageHint[] {
  const scored = pages
    .map((page) => ({ page, score: scorePage(text, page) }))
    .filter((entry) => entry.score > 0)
  if (scored.length === 0) return []
  const top = Math.max(...scored.map((entry) => entry.score))
  return scored.filter((entry) => entry.score === top).map((entry) => entry.page)
}

/**
 * 启发式判定（层 2）。返回 `undefined` 表示"判不了" —— 由调用方交给层 3（模型自判）。
 */
export function heuristicMode(input: {
  text: string
  pages?: readonly ModePageHint[]
}): { effective: EffectiveMode; reason: string } | undefined {
  const text = input.text.trim()
  if (!text) return undefined

  const multiStep = matchMultiStepSignal(text)
  if (multiStep) return { effective: 'plan', reason: `${MODE_REASONS.multiStep}（命中「${multiStep}」）` }

  const candidates = candidatePages(text, input.pages)
  if (candidates.length > 1) return { effective: 'plan', reason: MODE_REASONS.multiPage }

  const single = candidates[0]
  if (single && (single.requiredParamCount ?? 0) === 0) {
    return { effective: 'act', reason: MODE_REASONS.singlePage }
  }
  return undefined
}

/** 解析 `MODE_DEFAULT`（非法值一律回落到 `auto`） */
export function resolveDefaultMode(raw?: string): AgentMode {
  return raw === 'act' || raw === 'plan' || raw === 'auto' ? raw : 'auto'
}

/** 解析客户端传来的模式（非法值一律忽略，回落到会话模式） */
export function normalizeMode(raw?: string): AgentMode | undefined {
  return raw === 'act' || raw === 'plan' || raw === 'auto' ? raw : undefined
}

/**
 * 解析本轮的请求模式：客户端显式 > 会话当前 > 默认。
 */
export function resolveRequestedMode(input: {
  requested?: string
  sessionMode?: AgentMode
  defaultMode: AgentMode
}): AgentMode {
  return normalizeMode(input.requested) ?? input.sessionMode ?? input.defaultMode
}

/**
 * 判定本轮的生效模式（层 1 → 层 2 → 层 3）。
 *
 * 注意：本函数**不读 process.env**（`defaultMode` 由调用方传入），以便单测固定输入。
 */
export function resolveMode(input: ResolveModeInput, defaultMode: AgentMode = 'auto'): ModeDecision {
  const requested = resolveRequestedMode({
    requested: input.requested,
    sessionMode: input.sessionMode,
    defaultMode,
  })

  // 层 1：显式指定 —— 不再猜测
  if (requested === 'act' || requested === 'plan') {
    return { requested, effective: requested, decidedBy: 'user', reason: MODE_REASONS.explicit }
  }

  // 层 2：启发式
  const heuristic = heuristicMode({ text: input.text, pages: input.pages })
  if (heuristic) {
    return {
      requested,
      effective: heuristic.effective,
      decidedBy: 'heuristic',
      reason: heuristic.reason,
    }
  }

  // 层 3：计划倾向，模型自选（提示由 buildAgentContext 注入）
  return {
    requested,
    effective: 'plan',
    decidedBy: 'model' satisfies ModeDecidedBy,
    reason: MODE_REASONS.uncertain,
  }
}
