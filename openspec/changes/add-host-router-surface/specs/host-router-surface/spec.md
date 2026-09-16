# host-router-surface — 宿主直连渲染面

## ADDED Requirements

### Requirement: agent 导航驱动宿主真实 router

`createVueHostRuntime` SHALL 把 runtime 的导航落到宿主 vue-router（`name` / `params` / `query`），
并不向宿主路由表新增任何记录（MUST NOT `addRoute`）。

#### Scenario: agent 打开页面

- **WHEN** agent 发起 `render({ tag: 'user-list', replace: true })`
- **THEN** 宿主 router 的当前路由变为对应 `name` 的路由（地址栏随之变化），宿主 `<router-view>` 渲染真实页面组件

#### Scenario: 已是当前路由时不重复导航

- **WHEN** 目标路由与宿主当前路由一致（首屏 adopt 或重复 render）
- **THEN** 不触发多余的 `router.push` / `router.replace`，仅同步 props 旁路

#### Scenario: 路由表不被污染

- **WHEN** host 模式 runtime 完成 `init` 与若干次导航
- **THEN** 宿主 `router.getRoutes()` 不新增由 runtime 添加的记录

### Requirement: 宿主导航回流内核

宿主的导航（点击 `router-link`、浏览器前进/后退、宿主代码 `router.push`）SHALL 回流为内核导航，
`source` 标记为 `host`，且必须防止「内核推给 router → 又回流内核」的回环。

#### Scenario: 浏览器后退回流

- **WHEN** 用户点击浏览器后退
- **THEN** 内核 `navigate` 事件以 `source: 'host'` 广播，并同步给 agent（`page.navigated`）

#### Scenario: 不产生回环

- **WHEN** 内核驱动一次导航（agent 或页面发起）
- **THEN** 该次导航不会再次作为 `source: 'host'` 回流（并发导航下也不回环）

### Requirement: 内核守卫前移

内核注册的 `beforeEach` 守卫 SHALL 参与宿主 router 的导航判定：被拒时宿主导航 MUST 被中止，
调用方 MUST 收到结构化的失败结果而不是「router 成功、内核拒绝」的分裂状态。

#### Scenario: 守卫拒绝

- **WHEN** 内核守卫对目标路由返回 `false`，且 agent 发起该导航
- **THEN** 宿主的 URL 不变，agent 的调用返回 `{ ok: false, reason: 'aborted' }`

#### Scenario: 用户导航被同一守卫拒绝

- **WHEN** 内核守卫拒绝某路由，用户点击指向该路由的链接
- **THEN** 导航被中止，内核当前页保持不变

### Requirement: 页面目录与真实路由的一致性报告

host 模式 SHALL 在建立页面目录时找出「manifest 声明但宿主 router 此刻没有」的页面并**一次性报出**全名单；
该报告 MUST NOT 使初始化失败 —— 真实项目的页面路由常常是登录后 / 按权限才注册的。
导航到这类页面时 MUST 返回结构化失败（`reason: 'not-found'`）并给出可读原因，
MUST NOT 让内核当前页推进到宿主并未真正打开的路由。

#### Scenario: 名字写错 / 路由尚未注册

- **WHEN** manifest 声明 `name: 'NotThere'`，宿主路由表里没有该 name
- **THEN** 初始化仍然成功并告警一次列出全部缺失名；`navigate({ tag })` 返回
  `{ ok: false, reason: 'not-found', detail: '…未注册路由「NotThere」…' }`，内核当前页与宿主 URL 都不变

#### Scenario: 登录后路由补齐

- **WHEN** 用户登录后宿主按权限注册了该路由，agent 再次发起导航
- **THEN** 导航成功，页面在宿主 `<router-view>` 渲染

### Requirement: 宿主历史委托

host 模式的可回退判定与前进后退 SHALL 基于宿主真实历史（`history.state.position` / `router.go`），
内核自身的历史条目不得与真实 URL 发散。
#### Scenario: 回退到上一页

- **WHEN** 用户从 `/users/1` 回到 `/users` 后调用 `runtime.canGoBack`
- **THEN** 结果与宿主真实历史一致（首条记录时为 `false`）

### Requirement: expose 能力读取

host 模式 SHALL 从宿主当前路由挂载的组件实例读取 `defineExpose` 暴露的方法，并在导航完成后广播
`page-exposed-changed`（仅方法名）；无可读实例时 MUST 广播空 keys 且不抛错。

#### Scenario: 调用页面方法

- **WHEN** 当前页组件写了 `defineExpose({ refresh })`，agent 调用 `call_page_method({ name: 'refresh' })`
- **THEN** 真实组件的 `refresh` 被调用，结果按既有 tool result 通道返回

#### Scenario: 未写 defineExpose

- **WHEN** 当前页组件没有 `defineExpose`
- **THEN** `getPageExposed()` 返回 `null` / 空 keys，agent 收到「该方法未暴露」的结构化失败

### Requirement: props 旁路

host 模式 SHALL 把 agent / 宿主直传的归一 props 通过响应式旁路（`pageProps`）交付给页面，并允许宿主
页面经 `useRuntimeServices()` 读取；`passProps: false` 时 MUST 整体关闭该旁路。

#### Scenario: 页面读取 agent 直传 props

- **WHEN** agent 传 `props: { keyword: '张三' }` 打开页面，页面读取 `useRuntimeServices().pageProps.keyword`
- **THEN** 读到 `'张三'` 且随导航更新

#### Scenario: 关闭旁路

- **WHEN** `passProps: false`
- **THEN** 不发 `pageProps`，路由 params / query 仍照常生效

### Requirement: 宿主 app 获得 runtime context

`createVueHostRuntime` 传入宿主 `app` 时 SHALL 向其注入 runtime context，使宿主页面可经
`useRuntimeServices()` 使用 `nav` / `state` / `emit`（`tryUseRuntimeServices()` 由 `null` 变为可用）。

#### Scenario: 页面显式上报事件

- **WHEN** 页面调用 `useRuntimeServices().emit('saved', { id: 1 })`
- **THEN** 宿主收到页面事件并经既有 `page.emit` 通道转发给 agent

### Requirement: 单实例约束

host 模式 SHALL 在检测到同一页面存在多个 runtime 实例（`apiBus` 上报通道是全局单例）时给出告警，
避免两个面板互相抢占数据上报。

#### Scenario: 同页挂载两个面板

- **WHEN** 同一个页面里创建了第二个 host 模式 runtime
- **THEN** 运行时输出明确告警，提示数据上报通道为全局单例、不应多实例共存
