# runtime-page-surface — 内核与渲染面解耦

## ADDED Requirements

### Requirement: 内核与渲染面分离

runtime 内核 SHALL 只通过 `PageSurface` 与 `RuntimeHistory` 两个扩展点接触「页面怎么落到屏幕」，
内核自身 MUST NOT 引用容器、自定义元素、bundle 加载、样式隔离等 WC 概念。

#### Scenario: 内核以假 surface 驱动

- **WHEN** 用只实现 `mount` / `prepare` / `isReady` / `render` / `styles` / `getPageExposed` 的假 surface 创建 runtime
- **THEN** `init` / `navigate` / `back` 全部可完成，且不加载任何 bundle、不创建任何容器

#### Scenario: 内核不依赖 tag 结构

- **WHEN** 路由表的 `tag` 不含 `-`（非自定义元素标签）
- **THEN** 在宿主渲染面下导航与事件广播正常，内核不因 tag 形态报错

### Requirement: 容器渲染面行为等价

`surface: 'container'`（缺省值）SHALL 与解耦前行为逐字节等价：容器懒建与挂载顺序、`loading` → `ready` 两帧、
样式登记与版本单调递增、页级样式 scope、容器策略（`keep` / `unmount`）、memory router 桥、页面注册与 expose 广播。

#### Scenario: 首屏两帧渲染

- **WHEN** 页面 bundle 未加载时导航到某页
- **THEN** 先出一帧 `loading`（无页面样式），加载并注册页面后再出一帧 `ready`（含页面样式，`stylesVersion` 递增）

#### Scenario: 已加载页面只出一帧

- **WHEN** 已加载过的页面再次成为当前页
- **THEN** 只出一帧 `ready`，无多余 `loading`

### Requirement: commit 前的可渲染判定

内核 SHALL 在提交导航（commit）之前询问渲染面「这一页此刻能不能渲染」（`PageSurface.canRender`）；
渲染面给出原因时，内核 MUST 返回结构化失败并广播 `error`，且 **MUST NOT** 推进内核当前页
（避免「内核以为切了页、宿主 URL 没动」的分裂）。

#### Scenario: 渲染面拒绝某页

- **WHEN** `canRender` 对目标路由返回原因字符串（如「宿主 router 未注册该路由」）
- **THEN** 导航结果为 `{ ok: false, reason: 'not-found', detail: 原因 }`，`current` / `view` 停留在原页，
  `error` 事件照常广播给宿主

#### Scenario: 渲染面不实现该扩展点

- **WHEN** 渲染面没有实现 `canRender`（如 container 渲染面）
- **THEN** 行为与之前一致（可加载性由 `ensure` / `prepare` 表达），不产生额外判定

### Requirement: 宿主渲染面契约

`surface: 'host'` SHALL 接受宿主注入的 `HostSurface`，并由其提供渲染、expose 读取、历史与当前路由快照；
未提供 `hostSurface` 时创建 runtime MUST 立即报错。
#### Scenario: 未提供 hostSurface

- **WHEN** 传 `surface: 'host'` 但不传 `hostSurface`
- **THEN** 创建 runtime 抛出明确错误（说明缺少宿主渲染面实现）

#### Scenario: init 允许无挂载点

- **WHEN** host 模式下调用 `runtime.init()`
- **THEN** 不抛错、不要求 DOM 挂载点；视图事件与状态机照常工作

### Requirement: 外部历史接管

当渲染面提供 `RuntimeHistory` 时，runtime SHALL 以宿主历史为可回退判定的唯一来源，
`canGoBack` / `canGoForward` / `back()` / `forward()` / `go(delta)` MUST 委托宿主历史，且内核自身的
历史条目 MUST NOT 与其发散。

#### Scenario: 回退委托宿主

- **WHEN** host 模式下调用 `runtime.back()`
- **THEN** 调用宿主的 `history.go(-1)`，并在宿主完成导航（回流提交）后返回成功结果

#### Scenario: 越界回退

- **WHEN** 宿主已无更早记录（`canGoBack` 为 false）时调用 `runtime.back()`
- **THEN** 返回 `{ ok: false, reason: 'out-of-range' }`，且不产生新的提交

### Requirement: manifest 归一化支持无产物模式

manifest 归一化 SHALL 允许 `pages[].bundle` 缺省、`containers` 为空、页面 `framework` 由预注册渲染面兜底；
容器模式下既有严格校验（`bundle` 必填、tag 必须含 `-`、framework 必须可推断）MUST 保持生效。

#### Scenario: 宿主模式缺 bundle / containers

- **WHEN** manifest 无 `containers` 且页面无 `bundle`，宿主渲染面已预注册对应 framework
- **THEN** 归一化成功，路由表可用于导航与 agent 页面目录

#### Scenario: 容器模式仍严格

- **WHEN** container 模式下页面缺 `bundle`
- **THEN** 归一化仍抛错（不因本次放宽而静默通过）

### Requirement: 首屏纳入宿主当前路由

host 模式且 `adopt !== false` 时，runtime SHALL 在 `init` 阶段把宿主当前路由提交为内核当前页
（`source: 'initial'`），使 agent 首轮决策即知道用户所在页面。

#### Scenario: 首屏 adopt

- **WHEN** 宿主已处于 `/users` 且该路由在页面目录内，host 模式 `init` 完成
- **THEN** `runtime.current.route.tag` 为对应页面 tag，且不产生多余的浏览器历史条目

#### Scenario: 关闭 adopt

- **WHEN** 传 `adopt: false`
- **THEN** `init` 后内核当前页为空（`hasPage` 为 false），等待 agent 或用户导航
