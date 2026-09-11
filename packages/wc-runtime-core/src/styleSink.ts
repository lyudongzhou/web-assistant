// @webassistant/wc-runtime-core —— 样式落点桥（document → 容器 shadow root）
//
// 背景（为什么需要它）：
//   CSS-in-JS / UI 依赖会在运行时执行 `document.head.appendChild(<style>)` 之类。
//   业务 WC 渲染在容器 shadow root 内，而 document 树里的样式表匹配不到 shadow 树里的节点
//   （Shadow DOM 封装规则）→ 这些样式在 WC 里不生效。
//
// 本模块只提供「地基」，**不含任何 patch 原生对象的逻辑**：
//   1) 目标注册表：容器挂载时 addStyleTarget(shadowRoot)，卸载时注销。
//      状态挂在 globalThis + Symbol.for 上 —— 容器 bundle / 共享 chunk / 页面 bundle 是
//      多份模块副本，模块级变量会各持一份（同 activity.ts 的理由），挂全局才是唯一真相源。
//   2) shadowDocument(realDoc)：给「指定包」做词法遮蔽用的 document 代理。
//      vite-plugin-wc 会把目标包模块前置成
//        var document = (globalThis[Symbol.for("webassistant.styleSink.api")]||{}).shadowDocument(globalThis.document)
//      被遮蔽模块里的裸 document 引用都走代理。
//
// 「改道」模型（v2，取代旧的「原节点留 head + clone 进 shadow」）：
//   代理拦截 head / body 的 appendChild / insertBefore / append / prepend；命中
//   <style>/<link rel=stylesheet> 时把**库自己那个真节点**移进容器 shadow root
//   （不再往 head 放、也不再克隆）。节点归容器所有：容器卸载即随元素销毁；也没有
//   「克隆体与源不同步」和「mirrors 表钉住游离 shadow root」这两个旧问题。
//
// 「页级 scope」（摘下 / 挂回）：
//   页面 bundle 首次被 import 时注入的样式，归属 beginStyleScope() 设置的页面 tag。
//   切页时 activateStyleScope(tag) 把其它页的节点从容器摘下（保留在内存组里），切回再挂上
//   —— 因为 ESM 模块只求值一次，不能真销毁。
//
// 已知缺口（本方案有意不覆盖，见 vite-plugin-wc README）：
//   - 走全局属性路径的写法：window.document / globalThis.document / self.document …
//   - 未被列入 styleShim.packages 的依赖（含子依赖）
//   - `const doc = document` 且引用逃出被遮蔽模块
//   - `insertAdjacentHTML` 注入
//   - 单容器假设：改道固定投到 targets[0]（多容器 / 多 runtime 后续用 iframe 或 target 作用域解决）

/** 注册表状态（targets 等）挂在这个 symbol 下 */
export const STYLE_SINK_GLOBAL = Symbol.for('webassistant.styleSink')
/** shadowDocument 工厂挂在这个 symbol 下，供被遮蔽模块调用 */
export const STYLE_SINK_API_GLOBAL = Symbol.for('webassistant.styleSink.api')
/** 上面那个 symbol 的 description —— vite-plugin-wc 代码生成时引用同一份字符串 */
export const STYLE_SINK_API_KEY = 'webassistant.styleSink.api'

/** 改道 <style> 上打的标记（值 = 归属 scope，便于调试 / 断言） */
const SHADOW_ATTR = 'data-wa-shadow'
/** 需要拦截的插入方法（在 head / body 的元素代理上替换） */
const INSERT_METHODS = new Set(['appendChild', 'insertBefore', 'append', 'prepend'])

/** 未 beginStyleScope 时的兜底 scope（容器级 / 页面加载窗口外的注入，恒定挂在容器里） */
export const DEFAULT_STYLE_SCOPE = '__default__'

interface SinkState {
  /** 已登记的 shadow root（改道落点；单容器假设下只用 targets[0]） */
  targets: ShadowRoot[]
  /** 每个 scope（页面 tag）名下的改道节点 */
  groups: Map<string, Element[]>
  /** 改道节点 → 它归属的 scope（removeChild / 摘挂反查） */
  nodeScope: WeakMap<object, string>
  /** 当前注入归属的 scope（页面加载窗口内由 beginStyleScope 设置） */
  currentScope: string | null
  /** 当前展示的 scope（切页后只留它的节点挂在 target 里） */
  activeScope: string | null
}

function createState(): SinkState {
  return {
    targets: [],
    groups: new Map(),
    nodeScope: new WeakMap(),
    currentScope: null,
    activeScope: null,
  }
}

function getState(): SinkState {
  const global = globalThis as unknown as Record<symbol, SinkState | undefined>
  let state = global[STYLE_SINK_GLOBAL]
  if (!state) {
    state = createState()
    global[STYLE_SINK_GLOBAL] = state
  }
  return state
}

// ---------------------------------------------------------------- 目标注册表

/** 登记一个「样式收件人」shadow root（容器挂载时调用，幂等） */
export function addStyleTarget(root: ShadowRoot): void {
  if (!root) return
  const state = getState()
  if (state.targets.includes(root)) return
  state.targets.push(root)
}

/** 注销一个 shadow root（容器卸载时调用）。已改道的节点保留在内存组里，可重挂到新容器 */
export function removeStyleTarget(root: ShadowRoot): void {
  if (!root) return
  const state = getState()
  const index = state.targets.indexOf(root)
  if (index >= 0) state.targets.splice(index, 1)
}

/** 当前所有登记中的 shadow root（快照） */
export function currentStyleTargets(): ShadowRoot[] {
  return [...getState().targets]
}

/** 仅供测试：清空注册表、样式组与 scope 记录 */
export function resetStyleSink(): void {
  const global = globalThis as unknown as Record<symbol, SinkState | undefined>
  global[STYLE_SINK_GLOBAL] = createState()
}

// ---------------------------------------------------------------- 改道

/** 是否是「会带来样式表」的节点（<style> 或 <link rel="stylesheet">） */
function isStylesheetNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const el = node as { tagName?: unknown; rel?: unknown }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'STYLE') return true
  if (tag === 'LINK') return String(el.rel ?? '').toLowerCase() === 'stylesheet'
  return false
}

/** 把节点从它在的 target 上摘下来（不销毁、不丢引用） */
function detachNode(node: Element, state: SinkState): void {
  for (const target of state.targets) {
    if (node.parentNode === target) {
      try {
        target.removeChild(node)
      } catch {
        /* 已被移除：忽略 */
      }
    }
  }
}

/** 把节点挂到当前容器（单容器假设：targets[0]） */
function attachNode(node: Element, state: SinkState): void {
  const target = state.targets[0]
  if (!target) return
  if (node.parentNode === target) return
  target.appendChild(node)
}

/**
 * 改道：把库自己的样式节点移进容器 shadow root（取代「留 head + clone」）。
 * 归属由 currentScope 决定；只有「当前展示的 scope」才立即挂上，其余暂存组里等切换。
 * 返回 false 表示没有可用容器（调用方应回退到原生 head 插入）。
 */
function redirectNode(node: unknown): boolean {
  if (!isStylesheetNode(node)) return false
  const state = getState()
  if (!state.targets.length) return false

  const el = node as Element
  const scope = state.currentScope ?? DEFAULT_STYLE_SCOPE
  let group = state.groups.get(scope)
  if (!group) {
    group = []
    state.groups.set(scope, group)
  }
  state.nodeScope.set(el as object, scope)
  group.push(el)
  try {
    el.setAttribute(SHADOW_ATTR, scope)
  } catch {
    /* 只读实现：忽略 */
  }
  if (state.activeScope === scope || scope === DEFAULT_STYLE_SCOPE) attachNode(el, state)
  return true
}

// ---------------------------------------------------------------- 页级 scope

/** 页面加载窗口开始：之后注入的样式归属该 scope */
export function beginStyleScope(scope: string): void {
  getState().currentScope = scope
}

/** 页面加载窗口结束：后续注入不再归属上一个 scope */
export function endStyleScope(): void {
  getState().currentScope = null
}

/**
 * 切换当前展示的 scope：把其它 scope 的节点从容器摘下（保留在内存组），把本 scope 的挂回。
 * 幂等。scope 传 null 表示当前没有页面（全部摘下）。
 */
export function activateStyleScope(scope: string | null): void {
  const state = getState()
  if (state.activeScope === scope) return
  for (const [tag, group] of state.groups) {
    // 兜底 scope（容器级注入）不参与页级摘挂，恒定挂着
    if (tag === scope || tag === DEFAULT_STYLE_SCOPE) continue
    for (const node of group) detachNode(node, state)
  }
  if (scope) {
    const group = state.groups.get(scope)
    if (group) for (const node of group) attachNode(node, state)
  }
  state.activeScope = scope
}

/** 供 removeChild 兜底：把一个改道节点从组与容器上彻底移除 */
function dropRedirectedNode(node: Element): void {
  const state = getState()
  const scope = state.nodeScope.get(node as object)
  if (scope) {
    const group = state.groups.get(scope)
    if (group) {
      const index = group.indexOf(node)
      if (index >= 0) group.splice(index, 1)
    }
    state.nodeScope.delete(node as object)
  }
  detachNode(node, state)
}

/** 丢弃所有改道节点（runtime dispose 时调用，解除内存组对游离 shadow root 的引用） */
export function clearStyleScopes(): void {
  const state = getState()
  for (const group of state.groups.values()) {
    for (const node of group) detachNode(node, state)
  }
  state.groups.clear()
  state.nodeScope = new WeakMap()
  state.currentScope = null
  state.activeScope = null
}

// ---------------------------------------------------------------- 代理工厂

/**
 * 建一个「忠实透传」的代理：
 * - 命中的 overrides 直接返回；
 * - 其余属性用 `Reflect.get(target, key, target)` 读取 —— receiver 必须是真对象，
 *   否则原生取值器会以 proxy 作 this 触发品牌校验（实测：Illegal invocation）；
 * - 函数一律 bind 到真对象并缓存（保证 `typeof` / `===` / 调用语义不变）。
 */
export function bindProxy<T extends object>(
  real: T,
  overrides: Record<string, unknown> = {},
): T {
  const bound = new WeakMap<object, unknown>()
  return new Proxy(real, {
    get(target, key, _receiver) {
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(overrides, key)) {
        return overrides[key]
      }
      const value = Reflect.get(target, key, target) as unknown
      if (typeof value === 'function') {
        let cached = bound.get(value as object)
        if (!cached) {
          cached = (value as (...args: unknown[]) => unknown).bind(target)
          bound.set(value as object, cached)
        }
        return cached
      }
      return value
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target)
    },
  })
}

/** 建一个节点代理：样式节点的插入被「改道」进容器 shadow root，其余插入保持原生 */
function createElementProxy(el: Element): Element {
  const bound = new WeakMap<object, unknown>()
  const proxy = new Proxy(el, {
    get(target, key, _receiver) {
      if (typeof key === 'string' && INSERT_METHODS.has(key)) {
        const real = Reflect.get(target, key, target) as (...args: unknown[]) => unknown
        return (...args: unknown[]) => {
          // 拆出样式节点：改道进容器 shadow root；其余节点仍走原生插入。
          const styles: unknown[] = []
          const rest: unknown[] = []
          for (const arg of args) (isStylesheetNode(arg) ? styles : rest).push(arg)
          if (styles.length && styles.every((node) => redirectNode(node))) {
            if (rest.length) real.apply(target, rest)
            // 对齐原生返回值：appendChild / insertBefore 返回被插节点，append / prepend 返回 undefined
            return key === 'appendChild' || key === 'insertBefore' ? styles[0] : undefined
          }
          return real.apply(target, args)
        }
      }
      if (key === 'removeChild') {
        const real = Reflect.get(target, key, target) as (node: unknown) => unknown
        return (node: unknown) => {
          // 改道节点不在 head 里：从组与容器上移除，避免库调用 head.removeChild 时 NotFoundError
          if (getState().nodeScope.has(node as object)) {
            dropRedirectedNode(node as Element)
            return node
          }
          return real.call(target, node)
        }
      }
      const value = Reflect.get(target, key, target) as unknown
      if (typeof value === 'function') {
        let cached = bound.get(value as object)
        if (!cached) {
          cached = (value as (...args: unknown[]) => unknown).bind(target)
          bound.set(value as object, cached)
        }
        return cached
      }
      return value
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target)
    },
  })
  return proxy as unknown as Element
}

/**
 * 造一个「把样式插入改道到容器 shadow root」的 document 代理。
 * 用法（由 vite-plugin-wc 注入到指定包模块）：
 * ```js
 * var document = (globalThis[Symbol.for("webassistant.styleSink.api")] || {}).shadowDocument(globalThis.document)
 * ```
 */
export function shadowDocument(realDoc: Document): Document {
  const elements = new WeakMap<object, Element>()
  const wrap = (el: Element | null): Element | null => {
    if (!el) return el
    let cached = elements.get(el)
    if (!cached) {
      cached = createElementProxy(el)
      elements.set(el, cached)
    }
    return cached
  }
  return bindProxy(realDoc as unknown as object, {
    get head() {
      return wrap(realDoc.head)
    },
    get body() {
      return wrap(realDoc.body)
    },
  }) as unknown as Document
}

// ---------------------------------------------------------------- 全局安装（prelude）

export interface StyleSinkApi {
  shadowDocument(doc: Document): Document
  addStyleTarget(root: ShadowRoot): void
  removeStyleTarget(root: ShadowRoot): void
  currentStyleTargets(): ShadowRoot[]
  /** 页面加载窗口：之后注入的样式归属该 scope（页面 tag） */
  beginStyleScope(scope: string): void
  endStyleScope(): void
  /** 切换当前展示的 scope：其它 scope 的节点摘下、本 scope 挂回 */
  activateStyleScope(scope: string | null): void
  /** 丢弃所有改道节点（runtime dispose） */
  clearStyleScopes(): void
}

/**
 * 把 API 挂到 globalThis（幂等）。由 vite-plugin-wc 注入的 prelude 调用，
 * 保证被遮蔽模块求值之前 shadowDocument 已就位。
 */
export function installStyleSink(): StyleSinkApi {
  const global = globalThis as unknown as Record<symbol, StyleSinkApi | undefined>
  let api = global[STYLE_SINK_API_GLOBAL]
  if (!api) {
    api = {
      shadowDocument,
      addStyleTarget,
      removeStyleTarget,
      currentStyleTargets,
      beginStyleScope,
      endStyleScope,
      activateStyleScope,
      clearStyleScopes,
    }
    global[STYLE_SINK_API_GLOBAL] = api
  }
  return api
}
