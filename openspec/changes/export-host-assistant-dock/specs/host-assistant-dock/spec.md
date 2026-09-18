# host-assistant-dock — 宿主直连面的开箱即用面板

## ADDED Requirements

### Requirement: 一个标签 + 一个注入口即可接入

chat-client SHALL 导出可直接使用的宿主直连面板组件，宿主 MUST 只需提供 runtime 注入口
（`createRuntime`）与可选的宿主能力（`services`）即可获得完整交互。

#### Scenario: 最小接入

- **WHEN** 宿主渲染 `<HostAssistantDock :create-runtime="createRuntime" />`（`createRuntime` 来自
  `createVueHostRuntimeBinding({ router, app, services })`）
- **THEN** 面板自行完成 socket 连接、runtime 初始化、对话收发、页面事件与上报转发
- **AND** 宿主 MUST NOT 需要再传 `surface`（渲染面由「是否给了 `createRuntime`」推导）

#### Scenario: 收起不中断会话

- **WHEN** 用户点击「收起」
- **THEN** 面板隐藏但 runtime 与 socket MUST 继续存活（用 `v-show` 语义，不得卸载）
- **AND** 收起期间 agent 发起的导航 MUST 照常作用在宿主 router 上

### Requirement: UI 不依赖第三方组件库

面板与其子组件的样式 SHALL 全部通过 `--wa-*` CSS 变量表达，交互元素 MUST 使用原生
`button` / `textarea`，MUST NOT 依赖 element-plus 等 UI 库。

#### Scenario: 未安装 UI 库的宿主

- **WHEN** 宿主项目没有 element-plus
- **THEN** 面板外观完整可用（气泡 / 输入栏 / 按钮 / 折叠条都正常渲染）

#### Scenario: 主题跟随宿主

- **WHEN** 宿主在自己的根作用域覆盖 `--wa-primary` / `--wa-panel-bg` 等变量
- **THEN** 面板与会话区随之改变，无需改组件源码

### Requirement: 三层可定制性

组件 SHALL 提供三层定制入口，且各层职责不重叠：
整窗（props / 插槽）→ 组件（`HostAssistantChat` / `HostAssistantActivities` 单独使用）→
headless（`useWebAssistant()`）。

#### Scenario: 只要对话区

- **WHEN** 宿主只想在自定义布局里放一个对话区
- **THEN** MUST 可以单独使用 `HostAssistantChat`（数据进、事件出，不认识 socket / runtime）

#### Scenario: 接宿主自己的逻辑

- **WHEN** 宿主需要把 runtime 接进自己的 store 快照桥或调试句柄
- **THEN** MUST 可以通过 `onRuntimeReady(runtime)` 拿到框架无关的 runtime

### Requirement: 空态引导与页面目录对齐

面板在没有对话时 SHALL 展示可点击的建议；宿主未显式提供时，建议 MUST 由当前页面目录推导
（「打开『标题』」），且 SHALL 支持显式传入或关闭（`suggestions: []`）。

#### Scenario: 未配置文案的宿主

- **WHEN** 宿主不传 `suggestions` 且 manifest 已加载
- **THEN** 空态显示最多 3 条来自页面目录的建议，点击即发送

#### Scenario: 关闭建议区

- **WHEN** 宿主传 `suggestions: []`
- **THEN** 空态不出现建议按钮（标题与说明仍在）

### Requirement: 动作时间线可读

面板 SHALL 展示 agent 实际执行的动作（`call` / `navigate` / `data` / `emit` / `error`），
并 MUST 对详情做分段与截断（参数 / 返回值 / 错误），避免单条长 JSON 破坏可读性。

#### Scenario: 查看一次方法调用

- **WHEN** agent 通过 `call_page_method` 调用了页面方法
- **THEN** 时间线出现一条 `call` 记录（方法名 / 耗时 / `origin=agent` 高亮）
- **AND** 点开后显示 `args` 与 `result`（各段按上限截断），失败时显示 `error`
