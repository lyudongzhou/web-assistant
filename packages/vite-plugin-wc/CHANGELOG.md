# @webassistant/vite-plugin-wc

## 0.1.10

### Patch Changes

- Updated dependencies
  - @webassistant/analyzer@0.2.0

## 0.1.8

### Patch Changes

- 修复共享组件被 Rollup code-split 成独立 chunk 后，其 scoped 样式无法聚合进页面 styles 导出的问题（例如多个页面共用的 ObjectTreeSidebarUI 的 .domain-selector 样式丢失）。样式聚合现在会沿页面 chunk 的 imports / dynamicImports 做闭包，把可达 chunk 里的样式一并收集。

## 0.1.7

### Patch Changes

- 忽略 `<style module>`（CSS Module）：custom-element 模式下 `@vitejs/plugin-vue` 会抛 `<style module> is not supported in custom elements mode.`，现于 vue 插件之前（`enforce: "pre"`）把 `<style module>` 块剥掉跳过。`wcVuePlugin()` 返回类型由 `Plugin` 改为 `Plugin[]`。

## 0.1.6

### Patch Changes

- 修复共享组件（非页面 `.vue`）scoped 样式在 WC 构建中被抽出 `shared.css` 且无人加载、导致样式丢失的问题：`wcVuePlugin` 的 `customElement` 过滤改为匹配项目内所有 `.vue`（排除 node_modules），`wcBuildPlugin` 把页面依赖树里的共享组件样式聚合进各页面的 `styles` 导出。

## 0.1.5

### Patch Changes

- 发布 patch 版本，更新内部依赖联动。
- Updated dependencies
  - @webassistant/protocol@0.1.2
  - @webassistant/analyzer@0.1.2

## 0.1.4

### Patch Changes

- 通过 Rollup treeshake 将 node:\* 无副作用死路径剪除，避免 Node-only 依赖泄漏到浏览器 WC 产物。

## 0.1.3

### Patch Changes

- 进一步修复 0.1.2 transform 在 Vue 编译产物上的二次处理与同源重复声明问题：跳过 `?vue` 虚拟 id、同一 node 模块只 `import * as` 一次、具名绑定统一从该 namespace 取值。

## 0.1.2

### Patch Changes

- 修复 WC 构建将 node:_ 内置模块 external 后仍输出到浏览器产物的问题：插件改为把 node:_ 解析并转换为浏览器 noop stub。
