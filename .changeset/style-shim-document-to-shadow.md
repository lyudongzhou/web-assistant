---
"@webassistant/wc-runtime-core": minor
"@webassistant/wc-runtime-vue": minor
"@webassistant/vite-plugin-wc": minor
---

新增「样式落点桥」（`styleShim`）：把指定包往 `document` 注入的样式镜像进容器 shadow root。

**背景**：CSS-in-JS / UI 依赖在运行时 `document.head.appendChild(<style>)`；业务 WC 渲染在容器
shadow root 内，document 树里的样式表匹配不到 shadow 树里的节点 → 样式在 WC 里不生效。

- **`wc-runtime-core`**：新增 `styleSink.ts` ——
  目标注册表（`addStyleTarget` / `removeStyleTarget` / `currentStyleTargets`，状态挂
  `globalThis` + `Symbol.for`，跨 bundle 唯一）、`bindProxy`（解决 DOM 品牌校验的透传代理工厂）、
  `shadowDocument(realDoc)`（把 `<style>` / `<link rel=stylesheet>` 的插入镜像进注册表里的
  shadow root，含「空 style + `insertRule`」路径）、`installStyleSink()`。
  新增子路径导出 `@webassistant/wc-runtime-core/styleSink`。
- **`wc-runtime-vue`**：容器 `mountContainer` 把自身 shadow root 登记为样式收件人，
  `unmountContainer` / `dispose` 注销（无登记时桥完全不起作用）。
- **`vite-plugin-wc`**：新增 `wcBuildPlugin({ styleShim: { packages: [...] } })` ——
  给指定包模块前置 `var document = …shadowDocument(globalThis.document)`（模块级 transform，
  靠 Rollup 的 deconflict 把遮蔽范围收敛在被指定包内）+ 一个 `virtual:webassistant/style-sink`
  prelude 保证工厂先于被遮蔽模块求值。新增了对 `@webassistant/wc-runtime-core` 的依赖。
- **demo-app**（不走 changeset）：新增 `src/vendor/fakeCssInJs.ts` 验收探针，覆盖 P1
  （`appendChild` + `textContent`）与 P2（空 `<style>` + `insertRule`）两条注入路径。

**第二轮补齐**（由 `3d-force-graph` 真实依赖验收暴露）：

- 支持「**先挂空 `<style>`、再填内容**」的注入写法：拦截后在该 style 实例上挂钩
  `appendChild / append / textContent`，内容填上时同步进镜像（`sheet.insertRule` 已有）。
  之前只覆盖 emotion/styled-components 的 `insertRule`，会镜像到空壳。
- 修掉一个去重 bug：**多个包同时「空着插入」**时内容哈希相同 → 互相判重、只留第一条。
  空内容改用节点独立 key（`style:empty#N`）。这是 `3d-force-graph` + `three-render-objects`
  + `float-tooltip` 三个包同时注入时才暴露出来的。
- `vite-plugin-wc` 的包匹配补充说明：CSS-in-JS 常散在子依赖里，需逐包列入；
  构建后可核对产物中 `document.head || …getElementsByTagName("head")` 的未改写残留是否为 0。

**已知缺口**（有意不覆盖）：`window.document` / `globalThis.document` 等全局属性路径、未列入 `packages` 的子依赖、`const doc = document` 逃逸出被遮蔽模块、`insertAdjacentHTML`。
