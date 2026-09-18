// agent 预填（prefill）范式的公共件 —— demo-app 所有页面共用同一套约定：
//
//   ① agent → 页面的写通道**只有** call_page_method（调页面 defineExpose 暴露的方法），
//      所以「不让 agent 直接下发数据」的做法很直接：**页面不把写后端的方法 expose 出去**。
//      页面只暴露三类方法：只读（refresh）、视图操作（翻页 / 筛选 / 打开详情 / 导航）、
//      预填（打开配置界面并填好参数，但不提交）。
//   ② 这些方法的入参来自 LLM 生成的 JSON（tool args），TS 类型只是给 prompt 读的合同，
//      运行时必须自己兜底 → mergeAgentPreset 负责「只覆盖显式传值 + 类型归一」。
//   ③ 返回值会作为 tool.result 回流，是 agent 复述「我做了什么」的唯一依据 →
//      prefillReceipt / PagerSnapshot 负责统一回执形状（全部 JSON 可序列化）。

/** 统一文案：预填后页面上的提示（告诉用户「参数已填好，提交仍由你决定」） */
export const AGENT_PREFILL_HINT = '助手已预填，请确认后提交'

/** 预填回执：call_page_method 的返回值（agent 据此向用户复述「已经填了什么」） */
export interface AgentPrefillReceipt<T> {
  /** 被操作的界面（弹窗 / 表单名） */
  ui: string
  /** 界面是否已打开（表单常显的页面恒为 true） */
  open: boolean
  /** 生效后的表单快照 */
  form: T
}

/** 分页快照：翻页类方法的返回值，agent 据此判断「还有没有下一页」 */
export interface PagerSnapshot {
  page: number
  pageCount: number
  rowCount: number
}

/** preset 是否给了至少一个显式字段（决定要不要显示「助手已预填」提示） */
export function hasAgentPreset(preset?: object | null): boolean {
  return !!preset && Object.keys(preset).length > 0
}

/** agent 传值 → 表单值：只接受与基准值同型的值，字符串去空白、数字取有限值 */
function normalizeValue(fallback: unknown, next: unknown): unknown {
  if (next === undefined || next === null) return fallback
  if (typeof fallback === 'string') return typeof next === 'string' ? next.trim() : String(next)
  if (typeof fallback === 'number') {
    const value = Number(next)
    return Number.isFinite(value) ? value : fallback
  }
  if (typeof fallback === 'boolean') return next === true || next === 'true'
  return next
}

/**
 * 合并 agent 传来的预填值：以 base 为底，只覆盖 preset 里**显式给出**的键。
 * 未在 base 里声明的键直接丢弃 —— LLM 塞进来的无关字段不会污染表单。
 */
export function mergeAgentPreset<T extends object>(base: T, preset?: Partial<T> | null): T {
  const merged = { ...(base as unknown as Record<string, unknown>) }
  if (!preset || typeof preset !== 'object') return merged as unknown as T
  const incoming = preset as unknown as Record<string, unknown>
  for (const key of Object.keys(merged)) {
    if (!(key in incoming)) continue
    merged[key] = normalizeValue(merged[key], incoming[key])
  }
  return merged as unknown as T
}

/** 生成预填回执（页面预填方法统一返回它） */
export function prefillReceipt<T extends object>(ui: string, form: T, open = true): AgentPrefillReceipt<T> {
  return { ui, open, form: { ...form } }
}
