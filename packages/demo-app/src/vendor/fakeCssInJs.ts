// 模拟一个「CSS-in-JS 依赖」：它只用**裸 document** 往 <head> 注入样式。
//
// 用途：验收 vite-plugin-wc 的 styleShim（指定包词法遮蔽）——
// 构建成 WC 后，这些样式会被镜像进容器 <runtime-vue> 的 shadow root（带 data-wa-shadow 标记），
// 从而在 shadow DOM 里真正生效；SPA 模式（pnpm dev）下则照旧只进 document.head。
//
// 本文故意把 CSS-in-JS 最常见的两条注入路径都写了：
//   P1：createElement('style') + textContent + head.appendChild
//   P2：先 append 空 <style>，再用 sheet.insertRule 逐条塞规则（emotion / styled-components 写法）

/** P1：创建 <style>、写 textContent，再 appendChild 到 head */
export function injectByAppendChild(css: string): void {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}

/** P2：先 append 空 <style>，再用 sheet.insertRule 加规则 */
export function injectByInsertRule(css: string): void {
  const style = document.createElement('style')
  document.head.appendChild(style)
  const sheet = style.sheet
  if (sheet) sheet.insertRule(css, sheet.cssRules.length)
}
