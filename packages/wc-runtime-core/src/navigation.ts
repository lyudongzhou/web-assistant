// 导航控制器：runtime 的「当前页面」唯一真相源。
// agent 的 navigate 与页面里的 router.push 最终都汇入这里（后者经 RouterBridge 的 commit）。
import type {
  NavigationGuard,
  NavigationResult,
  NavigationSource,
  NavigationTarget,
  RuntimeLocation,
  RuntimeRoute,
  Unsubscribe,
} from './types.js'

const MAX_HISTORY = 50

export interface NavigationController {
  readonly routes: readonly RuntimeRoute[]
  readonly current: RuntimeLocation | null
  readonly currentRoute: RuntimeRoute | null
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly historySize: number
  /**
   * 当前导航的唯一 ID。每次 commit / go 产生一次新的导航（同一个重复 replace 不算），
   * 供 NetworkObserver 把请求关联到产生它的那次页面导航（protocol 的 PageObservationContext.navigationId）。
   */
  readonly navigationId: string
  getRoute(tagOrNameOrPath: string): RuntimeRoute | undefined
  resolve(target: NavigationTarget): NavigationResult
  /** 只判定不落地（供框架 router 的 beforeEach 调用） */
  canNavigate(target: NavigationTarget): NavigationResult
  /** 落地：更新 current + history 并通知订阅者 */
  commit(target: NavigationTarget): NavigationResult
  go(delta: number, source?: NavigationSource): NavigationResult
  setRoutes(routes: readonly RuntimeRoute[]): void
  beforeEach(guard: NavigationGuard): Unsubscribe
  subscribe(listener: (location: RuntimeLocation, route: RuntimeRoute) => void): Unsubscribe
  dispose(): void
}

function splitPath(path: string): { pathname: string; query: Record<string, string | string[]> } {
  const [pathname, search] = path.split('?', 2)
  const query: Record<string, string | string[]> = {}
  if (search) {
    for (const part of search.split('&')) {
      if (!part) continue
      const [rawKey, rawValue = ''] = part.split('=', 2)
      const key = decodeURIComponent(rawKey)
      const value = decodeURIComponent(rawValue)
      const prev = query[key]
      if (prev === undefined) query[key] = value
      else if (Array.isArray(prev)) prev.push(value)
      else query[key] = [prev, value]
    }
  }
  return { pathname: pathname || '/', query }
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** 用路由模板 + params 生成实际 path */
export function fillPath(template: string, params: Record<string, unknown>): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (whole, key: string) => {
    const value = params[key]
    return value === undefined || value === null ? whole : encodeURIComponent(String(value))
  })
}

/** 用路由模板反解 path 里的 params；不匹配返回 null */
export function parseParams(template: string, path: string): Record<string, string> | null {
  const tpl = segments(template)
  const actual = segments(path)
  if (tpl.length !== actual.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < tpl.length; i += 1) {
    if (tpl[i].startsWith(':')) out[tpl[i].slice(1)] = decodeURIComponent(actual[i])
    else if (tpl[i] !== actual[i]) return null
  }
  return out
}

function sameLocation(a: RuntimeLocation | null, b: RuntimeLocation): boolean {
  if (!a) return false
  return a.tag === b.tag && JSON.stringify(a.params) === JSON.stringify(b.params)
}

export function createNavigationController(
  routes: readonly RuntimeRoute[] = [],
): NavigationController {
  let table: RuntimeRoute[] = [...routes]
  const guards = new Set<NavigationGuard>()
  const listeners = new Set<(location: RuntimeLocation, route: RuntimeRoute) => void>()
  let entries: RuntimeLocation[] = []
  let index = -1
  let navId = ''

  const byTag = (tag: string): RuntimeRoute | undefined => table.find((r) => r.tag === tag)

  function getRoute(key: string): RuntimeRoute | undefined {
    return byTag(key) || table.find((r) => r.name === key) || table.find((r) => r.path === key)
  }

  function matchByPath(path: string): { route: RuntimeRoute; params: Record<string, string> } | null {
    const { pathname } = splitPath(path)
    for (const route of table) {
      const params = parseParams(route.path, pathname)
      if (params) return { route, params }
    }
    return null
  }

  function resolve(target: NavigationTarget): NavigationResult {
    if (!target || (!target.tag && !target.name && !target.path)) {
      return { ok: false, reason: 'empty', detail: '导航目标至少需要 tag / name / path 之一' }
    }
    let route: RuntimeRoute | undefined
    let params: Record<string, unknown> = { ...(target.params ?? {}) }
    let query: Record<string, string | string[]> = { ...(target.query ?? {}) }

    if (target.tag) route = byTag(target.tag)
    if (!route && target.name) route = table.find((item) => item.name === target.name)
    if (!route && target.path) {
      const matched = matchByPath(target.path)
      if (matched) {
        route = matched.route
        params = { ...matched.params, ...params }
      }
      query = { ...splitPath(target.path).query, ...query }
    }
    if (!route) {
      const key = target.tag ?? target.name ?? target.path ?? ''
      return { ok: false, reason: 'not-found', detail: `没有匹配的路由：${key}` }
    }

    const location: RuntimeLocation = {
      tag: route.tag,
      name: route.name,
      path: fillPath(route.path, params),
      params,
      query,
      props: { ...(target.props ?? {}) },
      source: target.source ?? 'host',
    }
    return { ok: true, location, route, duplicated: sameLocation(entries[index] ?? null, location) }
  }

  function runGuards(to: RuntimeLocation): boolean {
    const from = entries[index] ?? null
    for (const guard of [...guards]) {
      if (guard(to, from) === false) return false
    }
    return true
  }

  function notify(location: RuntimeLocation, route: RuntimeRoute): void {
    for (const listener of [...listeners]) listener(location, route)
  }

  function canNavigate(target: NavigationTarget): NavigationResult {
    const resolved = resolve(target)
    if (!resolved.ok) return resolved
    if (!runGuards(resolved.location)) {
      return { ok: false, reason: 'aborted', detail: '被 beforeEach 守卫中止' }
    }
    return resolved
  }

  function pushEntry(location: RuntimeLocation, replace: boolean, duplicated: boolean): void {
    if (index >= 0 && (replace || duplicated)) {
      entries[index] = location
      return
    }
    entries = entries.slice(0, index + 1)
    entries.push(location)
    if (entries.length > MAX_HISTORY) entries.shift()
    index = entries.length - 1
    navId = crypto.randomUUID()
  }

  return {
    get routes() {
      return table
    },
    get current() {
      return entries[index] ?? null
    },
    get currentRoute() {
      const location = entries[index]
      return location ? byTag(location.tag) ?? null : null
    },
    get canGoBack() {
      return index > 0
    },
    get canGoForward() {
      return index >= 0 && index < entries.length - 1
    },
    get historySize() {
      return entries.length
    },
    get navigationId() {
      return navId
    },
    getRoute,
    resolve,
    canNavigate,
    commit(target) {
      const checked = canNavigate(target)
      if (!checked.ok) return checked
      pushEntry(checked.location, target.replace === true, checked.duplicated)
      notify(checked.location, checked.route)
      return checked
    },
    go(delta, source = 'host') {
      if (!delta) return { ok: false, reason: 'out-of-range', detail: 'delta 不能为 0' }
      const next = index + delta
      if (next < 0 || next >= entries.length) {
        return { ok: false, reason: 'out-of-range', detail: `history 越界：${delta}` }
      }
      const location: RuntimeLocation = { ...entries[next], source }
      const route = byTag(location.tag)
      if (!route) return { ok: false, reason: 'not-found', detail: `路由已移除：${location.tag}` }
      if (!runGuards(location)) return { ok: false, reason: 'aborted' }
      index = next
      entries[index] = location
      navId = crypto.randomUUID()
      notify(location, route)
      return { ok: true, location, route, duplicated: false }
    },
    setRoutes(next) {
      table = [...next]
      const location = entries[index]
      if (!location || byTag(location.tag)) return
      // 当前路由被移除：剔除失效历史，回落到最近的有效条目并通知
      entries = entries.filter((entry) => byTag(entry.tag))
      index = entries.length - 1
      const fallback = entries[index]
      if (fallback) {
        navId = crypto.randomUUID()
        notify(fallback, byTag(fallback.tag)!)
      }
    },
    beforeEach(guard) {
      guards.add(guard)
      return () => {
        guards.delete(guard)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      guards.clear()
      listeners.clear()
      entries = []
      index = -1
    },
  }
}
