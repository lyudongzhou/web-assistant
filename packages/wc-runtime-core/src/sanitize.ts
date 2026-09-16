// 数据裁剪工具（纯函数）：把任意值裁到「体积 + 深度」安全范围内。
//
// 为什么独立成文件：原先它住在 observer.ts 里（网络自动观测的副产物）。自动观测已退役
// （见 docs/agent-session.md：数据只由宿主 / 页面显式 apiBus.report 上报），但裁剪逻辑仍被两处复用：
//   - kernel：apiBus 显式上报的数据做**体积硬上限**（防 token 爆）
//   - activity：本地留痕时间线的值快照
//
// 注意语义边界：本函数只做「工程性保护」（体积 / 深度 / 环引用），**不做**业务字段过滤 / 脱敏 ——
// 报什么给 agent 由调用方（宿主 / 页面）在调用点决定。

/** 深拷贝并在安全约束内精简数据（体积上限 + 深度上限 + 环引用） */
export function sanitizeData(
  raw: unknown,
  maxBytes: number,
  maxDepth: number,
): { data?: unknown; bodyTruncated: boolean } {
  let bodyTruncated = false
  const seen = new WeakSet<object>()

  function walk(value: unknown, depth: number): unknown {
    if (typeof value === 'string') {
      if (value.length > maxBytes) {
        bodyTruncated = true
        return `${value.slice(0, maxBytes)}...(truncated)`
      }
      return value
    }
    if (value === null || typeof value !== 'object') return value
    if (depth > maxDepth) { bodyTruncated = true; return `[depth > ${maxDepth}]` }
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const out: unknown[] = []
        let size = 0
        for (const item of value) {
          const walked = walk(item, depth + 1)
          const itemSize = estimateSize(walked) + 1 // +1 = 逗号
          if (size + itemSize > maxBytes) { bodyTruncated = true; out.push('...(truncated)'); break }
          out.push(walked)
          size += itemSize
        }
        return out
      }
      const obj = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      let size = 0
      for (const key of Object.keys(obj)) {
        const walked = walk(obj[key], depth + 1)
        const entrySize = estimateSize(key) + estimateSize(walked) + 2 // +2 = `:` 与 `,`
        if (size + entrySize > maxBytes) { bodyTruncated = true; out['...(truncated)'] = true; break }
        out[key] = walked
        size += entrySize
      }
      return out
    } finally { seen.delete(value) }
  }

  const data = walk(raw, 0)
  return { data, bodyTruncated }
}

/**
 * 估算一个**已裁剪值**序列化后的字符长度。
 * 入参必须来自 walk 的产物（无环引用），因此 JSON.stringify 必然成功；
 * 每个节点只在自己的父级被 stringify 一次，整体仍然是线性开销（不回到早先的 O(n²)）。
 */
function estimateSize(value: unknown): number {
  if (typeof value === 'string') return value.length + 2 // 含引号
  if (value === null || value === undefined) return 4
  if (typeof value === 'number' || typeof value === 'boolean') return 8
  try {
    const json = JSON.stringify(value)
    return json === undefined ? 4 : json.length
  } catch {
    return maxFallbackSize
  }
}

/** JSON.stringify 失败（理论不可达）时的保守估计，保证裁剪仍会前进 */
const maxFallbackSize = 1024
