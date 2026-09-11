// 日志小工具：统一处理「敏感/超大字段」的展示，避免日志被 payload 刷屏。

/**
 * 把任意值转成一行短文本；超过 max 字符就截断并标注原始长度。
 * 注意：Error 的 message/stack 是不可枚举属性，JSON.stringify 会得到 `{}`，
 * 因此必须先单独识别 Error，否则错误信息会丢失（这正是 `error={}` 的成因）。
 */
export function truncate(value: unknown, max = 200): string {
  const text = value instanceof Error
    ? `${value.name}: ${value.message}`
    : typeof value === 'string'
      ? value
      : (JSON.stringify(value) ?? String(value))
  return text.length > max ? `${text.slice(0, max)}…(len=${text.length})` : text
}

/** 面向「错误」的展示：Error 取 message（含 cause），其余走 truncate。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    const base = error.message || error.name
    return cause ? `${base}（cause: ${errorText(cause)}）` : base
  }
  return truncate(error)
}
