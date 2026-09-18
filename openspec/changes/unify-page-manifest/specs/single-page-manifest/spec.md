# single-page-manifest — 一份清单驱动两条渲染面

## ADDED Requirements

### Requirement: 一份清单

一个项目 SHALL 只需一份页面清单（`wc.pages.json`）与一条 manifest 生成命令；
宿主直连（host）与容器（WC）两条渲染面 MUST 消费**同一份** manifest。

#### Scenario: host 模式复用容器形状的 manifest

- **WHEN** 宿主用 `createVueHostRuntime({ manifestUrl: '/wc/manifest.json' })` 加载一份带
  `containers` 与 `pages[].bundle` 的 manifest
- **THEN** 初始化成功，页面目录与不带 WC 字段的 manifest 完全一致（`tag` / `name` / `path` / `title` / `props` 等）
- **AND** 不因存在 `containers` / `bundle` 而报错或尝试加载 bundle

#### Scenario: 不再需要第二份清单或第二个输出

- **WHEN** 项目只声明 `wc.pages.json`（含 `container`）并执行一次 manifest 生成
- **THEN** host 与容器两条链路都能拿到自己需要的全部信息；
  MUST NOT 需要 `wc.host.json` 或第二次分析命令

### Requirement: host 渲染面的 WC 字段归一化

`normalizeManifest` 在宿主渲染面（`forHostSurface`）下 SHALL 把 WC 专属字段归一为空：
`routes[].bundle === ''`、`containers` 为空数组。

#### Scenario: 容器形状 manifest 走 host 归一化

- **WHEN** 输入 manifest 含 `containers.vue` 与每页 `bundle`
- **THEN** 归一化结果的 `containers` 为空、每页 `bundle` 为 `''`
- **AND** `pages[].bundle` 缺失仍然合法（放宽语义不回退）

### Requirement: 模式差异不体现在清单里

清单 SHALL 表达页面能力目录（有哪些页、能做什么），MUST NOT 用来表达「某渲染面下少开放哪一页」；
后者属于运行时策略。

#### Scenario: 某页只在一种用法下开放

- **WHEN** 项目希望某页在 host 模式下不对 agent 开放
- **THEN** MUST 通过运行时策略表达（当前内核 API 只能整体开放或整体关闭该页）
- **AND** MUST NOT 通过复制第二份清单或用清单过滤字段实现
