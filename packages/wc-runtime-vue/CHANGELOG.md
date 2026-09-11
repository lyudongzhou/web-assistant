# @webassistant/wc-runtime-vue

## 0.2.0

### Minor Changes

- 修复 UI 库浮层（el-dialog / el-select 下拉 / tooltip）在 WC 模式下样式丢失的问题：

  - `wc-runtime-core` 新增 `hashString` 与 `injectLightDomStylesBulk`（按内容哈希去重、append-only 地批量注入光 DOM），并从入口导出。
  - `wc-runtime-vue` 在 `patchContainer` 时把页面/共享组件样式也补一份到光 DOM，使 teleport 到 body 的浮层能命中页面样式。

### Patch Changes

- Updated dependencies
  - @webassistant/wc-runtime-core@0.2.0

## 0.1.2

### Patch Changes

- 发布 patch 版本，更新内部依赖联动。
- Updated dependencies
  - @webassistant/protocol@0.1.2
  - @webassistant/wc-runtime-core@0.1.2
