// 「本轮动作」的纯逻辑：格式化与截断规则。
// 拆成独立无依赖模块，便于单测（不拉起 vue）；与 lib/welcome.ts / lib/initialPage.ts 同款。
//
// 为什么值得单独一层：这些规则决定「agent 到底执行了什么」读不读得出来（方法名 / 耗时 / 参数 / 返回值 /
// 失败原因），又最容易在调样式时被顺手改坏（比如把截断去了 → 一屏被一条长 JSON 糊满）。
import type { WcActivity } from '@webassistant/wc-runtime-vue/host'

/** 详情里单段（args / result）的截断长度 */
export const ACTIVITY_DETAIL_CLIP = 240

/** 列表里最多渲染多少条（缓冲本身由 activityBus / `activityLimit` 限制） */
export const ACTIVITY_VISIBLE_LIMIT = 40

/**
 * 动作详情：`args` / `result` / `error` 各一段，用 ` · ` 连接。
 * 三者都没有时给一句占位（避免点开后是一片空白，看不出是「真没参数」还是「渲染坏了」）。
 */
export function formatActivityDetail(
  activity: WcActivity,
  clip = ACTIVITY_DETAIL_CLIP,
): string {
  const parts: string[] = []
  if (activity.args !== undefined) parts.push(`args：${clipText(activity.args, clip)}`)
  if (activity.result !== undefined) parts.push(`result：${clipText(activity.result, clip)}`)
  if (activity.error) parts.push(`error：${activity.error}`)
  return parts.length ? parts.join(' · ') : '（无参数与返回值）'
}

/** 动作时间（本地 24 小时制，与容器面的执行监视面板一致） */
export function formatActivityTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 只渲染最近的 N 条（时间线最新在前） */
export function selectVisibleActivities(
  activities: readonly WcActivity[],
  limit = ACTIVITY_VISIBLE_LIMIT,
): WcActivity[] {
  return activities.slice(0, limit)
}

/** 一行的语义 key（同毫秒可能有多条，渲染时再拼索引兜底） */
export function activityKey(activity: WcActivity): string {
  return `${activity.at}-${activity.kind}-${activity.name ?? ''}`
}

/** JSON 化并截断：非字符串走 JSON.stringify；循环引用等异常回落 String() */
function clipText(value: unknown, limit: number): string {
  let raw: string
  try {
    raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  } catch {
    raw = String(value)
  }
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw
}
