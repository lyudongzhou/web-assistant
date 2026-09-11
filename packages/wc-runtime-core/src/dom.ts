// 纯 DOM 工具（框架无关）。core 其余部分不依赖 DOM，这个文件是唯一例外，且全部做 typeof 守卫。
const injectedKeys = new Set<string>()

/**
 * 把 CSS 注入 <head>（按 key 只注入一次）。
 * 用途：UI 库浮层（el-select 下拉 / tooltip / dialog）默认 teleport 到 document.body，
 * 跑到容器 shadow 边界之外 —— 这是隔离方案的已知泄漏点，必须在光 DOM 补一份样式。
 */
export function injectLightDomStyles(css: string, key = 'default'): boolean {
  if (typeof document === 'undefined' || !css) return false
  const attr = 'data-wa-light'
  if (injectedKeys.has(key) || document.querySelector(`style[${attr}="${key}"]`)) return false
  const style = document.createElement('style')
  style.setAttribute(attr, key)
  style.textContent = css
  document.head.appendChild(style)
  injectedKeys.add(key)
  return true
}

/**
 * :root → :host 重写。UI 库（如 element-plus）把设计变量定义在 :root 上，
 * 注入 shadow DOM 后 :root 匹配不到 shadow host，变量不会向下继承。
 */
export function rewriteRootToHost(css: string): string {
  return css.replace(/:root\b/g, ':host')
}

/** 构造可跨多个 shadow root 共享的样式表；不支持时返回 null（调用方回退到 <style> 文本） */
export function createSharedSheet(css: string): CSSStyleSheet | null {
  if (typeof CSSStyleSheet === 'undefined') return null
  try {
    const sheet = new CSSStyleSheet()
    // replaceSync 在部分实现里不可用
    if (typeof (sheet as { replaceSync?: unknown }).replaceSync !== 'function') return null
    sheet.replaceSync(css)
    return sheet
  } catch {
    return null
  }
}

/** 把共享样式表挂到 shadow root（幂等，保留已有表） */
export function adoptSheets(root: ShadowRoot, sheets: readonly CSSStyleSheet[]): boolean {
  if (!root || !sheets.length) return false
  const target = root as ShadowRoot & { adoptedStyleSheets?: CSSStyleSheet[] }
  if (!Array.isArray(target.adoptedStyleSheets)) return false
  const existing = target.adoptedStyleSheets
  const next = sheets.filter((sheet) => !existing.includes(sheet))
  if (!next.length) return false
  target.adoptedStyleSheets = [...existing, ...next]
  return true
}

/** 把主题写成 CSS 变量作用在元素上（:host 继承给 shadow 树内所有节点） */
export function applyThemeVars(el: HTMLElement, theme: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries(theme)) {
    const name = key.startsWith('--') ? key : `--${key}`
    el.style.setProperty(name, value)
  }
}

/** 拼接资源地址：base 为空时原样返回，已是绝对地址（含协议或以 / 开头）时不拼 */
export function joinUrl(base: string | undefined, path: string): string {
  if (!path) return path
  if (!base) return path
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return path
  if (path.startsWith('/')) return path
  const left = base.endsWith('/') ? base.slice(0, -1) : base
  const right = path.startsWith('./') ? path.slice(2) : path
  return `${left}/${right}`
}

/** 仅供测试：重置注入记录 */
export function resetLightDomStyles(): void {
  injectedKeys.clear()
}

/**
 * 简单非加密哈希（FNV-1a），返回短字符串。
 * 用于给光 DOM 注入的页面样式生成稳定去重 key（避免把整段 CSS 塞进 data-wa-light 属性）。
 */
export function hashString(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * 批量把样式注入光 DOM（按内容哈希去重、append-only）。
 * 用途：页面/共享组件的样式默认进容器 shadow root，但浮层（el-dialog / select 下拉 / tooltip）
 * teleport 到 body 后跑出 shadow 边界，必须把这些样式也补一份到光 DOM。这是隔离方案的已知泄漏点。
 * 返回本次实际新增注入的条数。
 */
export function injectLightDomStylesBulk(cssList: readonly string[], prefix = 'wa-page'): number {
  let injected = 0
  for (const css of cssList) {
    if (!css) continue
    if (injectLightDomStyles(css, `${prefix}-${hashString(css)}`)) injected++
  }
  return injected
}
