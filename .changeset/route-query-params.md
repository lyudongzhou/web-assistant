---
'@webassistant/protocol': minor
'@webassistant/analyzer': minor
'@webassistant/wc-runtime-core': minor
'@webassistant/vite-plugin-wc': minor
---

路由入参通道显式化：path 之外还能声明 query 参数（页面写 `route.query.x` 也能被 agent 传参驱动）。

- **`protocol`**：`ManifestParam` 新增 `in?: 'path' | 'query'`（缺省 `path`，**path 参数不写该字段** ⇒ 旧 manifest / 手写 manifest 完全兼容）与 `description`；
  `WcPageEntry` 新增 `query?: Array<Omit<ManifestParam, 'in'>>` 显式声明逃生口（**可选**；通道固定 query —— 动态键 / 模板不可见 / 想覆盖说明或类型）。
- **`analyzer`**：新增 `src/routeScan.ts` —— 纯 AST 探测页面源码里的 `route.query.x` 读取
  （`useRoute()` 绑定名 / `{ query: q }` 别名 / `route.query['x']` / `const { x: alias } = route.query` / 内联 / 模板 `$route.query.x`），
  带类型推断（同名 props > 包装调用 > 兜底字面量 > 恒等比较 > `string`）与诊断（动态键 / 整块读 / `route.params.x` 与 path 不一致）；
  查询参数的 `description` 只取声明处注释的**第一行**（续行是开发者向说明，不出网进 prompt），诊断按通道指路
  （params 不一致 → 补 path 段位或改读 query），显式声明与 path 段同名时提示「会形成双通道两条入参」；
  `resolvePageParams()` 是 analyzer 与 `vite-plugin-wc` 共用的装配入口（顺手消掉两份重复的 `extractParams`）；
  `AiPageResult` 新增 `paramDescriptions`（AI 只给已探测到的参数补说明）。
- **`wc-runtime-core`**：`resolve()` 按 `route.params[].in` 把 agent 的 `params` 分流到 `location.query`（值收口 `string` / `string[]`），
  未声明的键保持旧行为；`sameLocation()` 计入 query（query 变化 = 新导航，back 能回到上一个筛选条件）；
  `resolveProps()` 让声明过的 prop 从 `params ?? query` 取值，但不把未声明的 query 键写进 props（避免污染元素属性）。
- **`vite-plugin-wc`**：manifest 生成改用 analyzer 的 `resolvePageParams`，两条构建路径不再各算一套。
- **`chat-client` / `wc-runtime-vue`**：无需改动（`location.query` 早已被容器 memory router 桥与宿主真实 router 桥消费）。
- **`agent-server`**（未发版）：prompt 参数按通道分段（`路径参数：` / `查询参数：`）+ 一条「两种通道都放进 `render` 的 params」规则句。
