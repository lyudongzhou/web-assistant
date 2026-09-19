// params / agentProps → 业务 WC 的 props。
// agent（LLM）传来的值多为字符串，需按 manifest 声明的 type 归一；对象/数组必须保持引用，
// 由 adapter 写成 element property（attribute 无法承载对象）。
import type { RuntimeRoute } from './types.js'

function coerceScalar(value: string, type: string): unknown {
  const t = type.toLowerCase()
  if (t === 'number') {
    const n = Number(value)
    return Number.isNaN(n) ? value : n
  }
  if (t === 'boolean') {
    if (value === '' || value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
    return Boolean(value)
  }
  if (t === 'object' || t === 'array') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

/** 按声明类型归一单个值：非字符串原样返回（对象/数组保持引用） */
export function coerceValue(value: unknown, type?: string): unknown {
  if (value == null) return value
  if (!type || typeof value !== 'string') return value
  return coerceScalar(value, type)
}

export interface ResolvePropsInput {
  route: RuntimeRoute
  params?: Record<string, unknown>
  /** query 通道下发的入参（manifest 标记 `in: 'query'`；由 NavigationController 分流） */
  query?: Record<string, unknown>
  /** agent / 宿主直传的 props，优先级最高 */
  props?: Record<string, unknown>
}

/**
 * 计算下发给业务 WC 的 props：
 * 1. **路径**参数（按 params[].type 归一）—— 方便页面直接用 props 取 id，不必依赖 useRoute
 * 2. 声明的 props（按 props[].type 归一）：值优先取 params（path 参数 / agent 直传），其次 query 通道
 * 3. 直传 props（优先级最高；未声明的键也透传，研究阶段保持宽松）
 *
 * 注意：`in: 'query'` 的参数**不**做第 1 步的自动归一 —— query 键由 analyzer 从源码探测得来，
 * 直接写成元素属性会污染 `id` / `title` 这类 HTML 属性；页面要 props 就显式 `defineProps` 声明（第 2 步覆盖）。
 */
export function resolveProps(input: ResolvePropsInput): Record<string, unknown> {
  const { route } = input
  const params = input.params ?? {}
  const query = input.query ?? {}
  const direct = input.props ?? {}
  const out: Record<string, unknown> = {}

  for (const def of route.params) {
    if (def.in === 'query') continue
    if (def.name in params) out[def.name] = coerceValue(params[def.name], def.type)
  }
  for (const def of route.props) {
    const raw = def.name in params ? params[def.name] : def.name in query ? query[def.name] : undefined
    if (raw !== undefined) out[def.name] = coerceValue(raw, def.type)
    if (def.name in direct) out[def.name] = coerceValue(direct[def.name], def.type)
  }
  const declared = new Map(route.props.map((p) => [p.name, p.type]))
  for (const [name, value] of Object.entries(direct)) {
    out[name] = declared.has(name) ? coerceValue(value, declared.get(name)) : value
  }
  return out
}
