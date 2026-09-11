---
"@webassistant/wc-runtime-core": minor
---

**styleShim 由「克隆」改为「改道」+ 页级 scope**

- `shadowDocument` 代理不再「原节点留 head + clone 进 shadow」，而是命中的 `<style>` / `<link rel=stylesheet>`
  把**库自己的真节点**直接移进容器 shadow root：节点进了已连接的 shadow root 后自身 `sheet` 即生效，
  因此 `sheet.insertRule/deleteRule`、`appendChild(textNode)`、`textContent = css` 都直接作用在它自己身上 ——
  不再需要挂钩同步，也不再按内容哈希去重（旧实现里「多个包同时空着插入互相撞车」的问题随之消失）。
- 样式归容器所有：`unmountContainer` / `dispose` 时随容器元素一起销毁，不再有「mirrors 表钉住游离
  shadow root」的泄漏。
- 新增**页级 scope**：`beginStyleScope(tag)` / `endStyleScope()` 标记页面加载窗口，`activateStyleScope(tag)`
  在切页时把非当前页的节点从容器摘下（缓存）、切回再挂回（ESM 只求值一次，不能真销毁）；
  `clearStyleScopes()` 在 `runtime.dispose` 清空。未 `beginStyleScope` 的（容器级）注入归
  `DEFAULT_STYLE_SCOPE`，恒定挂着、不参与摘挂。
- `runtime.ts`：`ensurePage` 用 `beginStyleScope(route.tag)` 包住页面 bundle 加载；`render()` 调
  `activateStyleScope(当前页 tag)`；`dispose()` 调 `clearStyleScopes()`。
- 已知限制：改道固定投到 `targets[0]`（单容器假设）；库调用 `head.removeChild(改道节点)` 由代理兜底处理。
