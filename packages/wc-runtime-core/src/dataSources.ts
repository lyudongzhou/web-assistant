import type { ManifestDataSource } from '@webassistant/protocol'

/**
 * 按 dataSources 白名单匹配 URL，返回命中的 dataSource（或 null）。
 * match 是子串匹配（URL 包含 match 字符串即命中）。
 */
export function matchDataSource(
  url: string,
  dataSources?: ManifestDataSource[],
): ManifestDataSource | null {
  if (!dataSources?.length) return null
  return dataSources.find((ds) => url.includes(ds.match)) ?? null
}

/**
 * 按 dataSources 声明对数据做摘要/截断/脱敏。
 * 返回 { data, truncated }。
 */
export function summarizeData(
  data: unknown,
  ds: ManifestDataSource,
): { data: unknown; truncated: boolean } {
  if (data === null || data === undefined) return { data, truncated: false }
  if (typeof data !== 'object') return { data, truncated: false }

  let result: unknown = data
  let truncated = false

  // 数组截断
  if (Array.isArray(data)) {
    const maxRows = ds.maxRows ?? 20
    if (data.length > maxRows) {
      result = data.slice(0, maxRows)
      truncated = true
    }
  }

  // 字段白名单过滤（只对数组元素或单对象生效）
  if (ds.fields?.length) {
    result = pickFields(result, ds.fields)
  }

  // 脱敏
  if (ds.mask?.length) {
    result = maskFields(result, ds.mask)
  }

  return { data: result, truncated }
}

function pickFields(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data)) return data.map((row) => pickOne(row, fields))
  return pickOne(data, fields)
}

function pickOne(row: unknown, fields: string[]): unknown {
  if (!row || typeof row !== 'object') return row
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (field in (row as Record<string, unknown>)) {
      out[field] = (row as Record<string, unknown>)[field]
    }
  }
  return out
}

function maskFields(data: unknown, maskFields: string[]): unknown {
  if (Array.isArray(data)) return data.map((row) => maskOne(row, maskFields))
  return maskOne(data, maskFields)
}

function maskOne(row: unknown, fields: string[]): unknown {
  if (!row || typeof row !== 'object') return row
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = fields.includes(key) ? '***' : value
  }
  return out
}
