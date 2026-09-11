// 框架无关的 NetworkObserver：透明包装 window.fetch 与 XMLHttpRequest，
// 把每个请求的生命周期转成可订阅的 observation 事件（request/response/error/timeout）。
//
// 约束（TODO.md §5）：
// - 业务页面不感知本模块 —— 拦截是透明的。
// - 不上传 Cookie / Authorization / Token 头；响应按大小截断；支持 URL 黑名单。
// - 请求与当前 navigationId 关联。
// - start/stop 幂等；dispose 恢复原生实现并清理全部订阅。

import type {
  PageNetworkError,
  PageNetworkRequest,
  PageNetworkResponse,
  PageNetworkTimeout,
  PageObservationContext,
} from '@webassistant/protocol/observation'

export type NetworkObservation =
  | PageNetworkRequest
  | PageNetworkResponse
  | PageNetworkError
  | PageNetworkTimeout

export interface NetworkObserverOptions {
  /** 当前页面标签 + navigationId 的读取器；导航后由 runtime 更新（缺省空上下文） */
  context?: () => PageObservationContext
  /** 不观察的 URL 前缀黑名单（默认空） */
  blockedPrefixes?: string[]
  /** response.data 最大字节数（默认 64KB） */
  maxResponseBytes?: number
  /** 提取 JSON 最大层级（默认 4） */
  maxDepth?: number
  /** 覆盖全局 fetch（node 测试可注入） */
  fetchImpl?: typeof fetch
  /** 覆盖全局 XMLHttpRequest 构造函数 */
  xhrCtor?: new () => XMLHttpRequest
  /** 是否自动 start（默认 false，方案 B 手动上报为主；需要时显式传 true 或手动 start） */
  autoStart?: boolean
}

export interface NetworkObserver {
  on(listener: (observation: NetworkObservation) => void): () => void
  start(): void
  stop(): void
  readonly started: boolean
  readonly pending: ReadonlyMap<string, 'pending'>
  dispose(): void
}

/** 深拷贝并在安全约束内精简数据（也被 activity 总线复用作脱敏/截断） */
export function sanitizeData(
  raw: unknown,
  maxBytes: number,
  maxDepth: number,
): { data?: unknown; bodyTruncated: boolean } {
  let bodyTruncated = false
  const seen = new WeakSet<object>()

  function walk(value: unknown, depth: number): unknown {
    if (value === null || typeof value !== 'object') return value
    if (depth > maxDepth) { bodyTruncated = true; return `[depth > ${maxDepth}]` }
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const out: unknown[] = []
        for (const item of value) {
          out.push(walk(item, depth + 1))
          if (JSON.stringify(out).length > maxBytes) {
            bodyTruncated = true; out.push('...(truncated)'); break
          }
        }
        return out
      }
      const obj = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(obj)) {
        out[key] = walk(obj[key], depth + 1)
        if (JSON.stringify(out).length > maxBytes) {
          bodyTruncated = true; out['...(truncated)'] = true; break
        }
      }
      return out
    } finally { seen.delete(value) }
  }
  const data = walk(raw, 0)
  return { data, bodyTruncated }
}

function parseResponseBody(raw: string, maxBytes: number, maxDepth: number): { data?: unknown; bodyTruncated?: boolean } {
  if (raw.length > maxBytes) return { data: raw.slice(0, maxBytes), bodyTruncated: true }
  try {
    const parsed: unknown = JSON.parse(raw)
    const result = sanitizeData(parsed, maxBytes, maxDepth)
    return result.bodyTruncated ? { data: result.data, bodyTruncated: true } : { data: result.data }
  } catch { return {} }
}

export function createNetworkObserver(options: NetworkObserverOptions = {}): NetworkObserver {
  const { context, blockedPrefixes = [], maxResponseBytes = 64 * 1024, maxDepth = 4,
    fetchImpl, xhrCtor, autoStart = false } = options

  const listeners = new Set<(observation: NetworkObservation) => void>()
  const pending = new Map<string, 'pending'>()
  let active = false
  let disposed = false
  const originalFetch = typeof fetch === 'function' ? fetch : undefined
  const OriginalXHR = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined
  const fetchBase = fetchImpl ?? originalFetch
  const XHRBase = xhrCtor ?? OriginalXHR

  function isBlocked(url: string): boolean {
    return blockedPrefixes.some((prefix) => url.startsWith(prefix))
  }
  function emit(observation: NetworkObservation): void {
    if (disposed) return
    for (const listener of [...listeners]) listener(observation)
  }
  function trackContext(): PageObservationContext { return context ? context() : {} }
  function rid(): string {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  }

  // ---- fetch 包装 ----
  async function wrappedFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (typeof input !== 'string' && input instanceof Request ? input.method : 'GET')).toUpperCase()
    const ctx = trackContext()
    const id = rid()
    const startedAt = Date.now()
    emit({ type: 'page.network.request', requestId: id, method, url, ...ctx, startedAt })
    pending.set(id, 'pending')
    try {
      const res = await fetchBase!.call(this, input, init)
      const body = await (async () => {
        try { return parseResponseBody(await res.clone().text(), maxResponseBytes, maxDepth) } catch { return {} }
      })()
      pending.delete(id)
      emit({ type: 'page.network.response', requestId: id, method, url, status: res.status, ok: res.ok,
        ...(body.data !== undefined ? { data: body.data } : {}), ...(body.bodyTruncated ? { bodyTruncated: true } : {}),
        receivedAt: Date.now(), durationMs: Date.now() - startedAt, ...ctx })
      return res
    } catch (error) {
      pending.delete(id)
      emit({ type: 'page.network.error', requestId: id, method, url,
        error: error instanceof Error ? error.message : String(error),
        failedAt: Date.now(), durationMs: Date.now() - startedAt, ...ctx })
      throw error
    }
  }

  // ---- XHR 包装 ----
  function wrappedXhrSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const xhr = this
    const method = String((xhr as unknown as Record<string, unknown>).__wa_method || 'GET')
    const url = String((xhr as unknown as Record<string, unknown>).__wa_url || '')
    if (isBlocked(url)) { return }
    const originalSend = (
      (XHRBase!.prototype as unknown as Record<string, unknown>).__wa_originalSend as typeof XMLHttpRequest.prototype.send | undefined
    )
    const ctx = trackContext()
    const id = rid()
    const startedAt = Date.now()
    emit({ type: 'page.network.request', requestId: id, method, url, ...ctx, startedAt })
    pending.set(id, 'pending')
    const finish = (observation: NetworkObservation): void => { pending.delete(id); emit(observation) }
    const onLoad = (): void => {
      finish({ type: 'page.network.response', requestId: id, method, url,
        status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300,
        ...(xhr.responseText && xhr.responseType === ''
          ? (() => { const p = parseResponseBody(xhr.responseText, maxResponseBytes, maxDepth)
              return p.data !== undefined ? { data: p.data } : {} })()
          : {}),
        receivedAt: Date.now(), durationMs: Date.now() - startedAt, ...ctx })
      xhr.removeEventListener('load', onLoad)
    }
    const onError = (): void => {
      finish({ type: 'page.network.error', requestId: id, method, url, error: 'XMLHttpRequest error',
        failedAt: Date.now(), durationMs: Date.now() - startedAt, ...ctx })
      xhr.removeEventListener('error', onError)
    }
    const onTimeout = (): void => {
      finish({ type: 'page.network.timeout', requestId: id, method, url,
        timeoutMs: xhr.timeout, timedOutAt: Date.now(), ...ctx })
      xhr.removeEventListener('timeout', onTimeout)
    }
    xhr.addEventListener('load', onLoad)
    xhr.addEventListener('error', onError)
    xhr.addEventListener('timeout', onTimeout)
    originalSend?.call(xhr, body)
  }

  const observer: NetworkObserver = {
    on(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start() {
      if (disposed) throw new Error('NetworkObserver 已 dispose')
      if (active) return
      active = true
      if (fetchBase) {
        const g = globalThis as unknown as Record<string, unknown>
        if (g.fetch !== wrappedFetch) { g.__wa_originalFetch = g.fetch; g.fetch = wrappedFetch as typeof fetch }
      }
      if (XHRBase) {
        const proto = XHRBase.prototype as unknown as Record<string, unknown>
        if (proto.send !== wrappedXhrSend) { proto.__wa_originalSend = proto.send; proto.send = wrappedXhrSend }
        const origOpen = XMLHttpRequest.prototype.open
        XHRBase.prototype.open = function open(
          this: XMLHttpRequest,
          method: string,
          url: string | URL,
          async?: boolean,
          username?: string | null,
          password?: string | null,
        ) {
          const href = typeof url === 'string' ? url : url.href
          ;(this as unknown as Record<string, unknown>).__wa_method = method.toUpperCase()
          ;(this as unknown as Record<string, unknown>).__wa_url = href
          return origOpen.call(this, method, typeof url === 'string' ? url : href, async ?? true, username, password)
        } as typeof XMLHttpRequest.prototype.open
      }
    },
    stop() {
      if (!active) return
      active = false
      const g = globalThis as unknown as Record<string, unknown>
      if (g.__wa_originalFetch !== undefined) { g.fetch = g.__wa_originalFetch; delete g.__wa_originalFetch }
      if (XHRBase) {
        const proto = XHRBase.prototype as unknown as Record<string, unknown>
        if (proto.__wa_originalSend !== undefined) { proto.send = proto.__wa_originalSend; delete proto.__wa_originalSend }
      }
    },
    get started() { return active },
    get pending() { return pending },
    dispose() {
      if (disposed) return
      disposed = true
      this.stop()
      listeners.clear()
      pending.clear()
    },
  }

  if (autoStart) observer.start()
  return observer
}
