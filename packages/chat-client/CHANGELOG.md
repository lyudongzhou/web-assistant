# @webassistant/chat-client

## 0.6.1

### Patch Changes

- Updated dependencies [7c0d8b2]
  - @webassistant/protocol@0.4.0
  - @webassistant/wc-runtime-core@0.4.0
  - @webassistant/wc-runtime-vue@0.5.1

## 0.6.0

### Minor Changes

- 宿主直连面（用法 B）**开箱即用**：导出悬浮窗 / 对话区 / 动作时间线三个组件

  此前这套面板只活在 demo 里（`AssistantChat.vue` + `AssistantDock.vue`），第三方要用只能抄。现在：

  - **`<HostAssistantDock>`** —— 右下角悬浮窗：头部（连接态 / 返回 / 新会话 / 收起）+ 状态行
    （连接 / 导航来源 / runtime / 当前页 expose）+ 对话 + 「本轮动作」时间线，全部接好线。
    宿主**只需一个 `createRuntime`**：
    ```vue
    const { createRuntime } = createVueHostRuntimeBinding({ router, app,
    services })
    <HostAssistantDock :create-runtime="createRuntime" :services="services" />
    ```
    可定制：`title` / `badge` / `placeholder` / `suggestions`（缺省从页面目录推「打开『XX』」）/ `helloTitle` /
    `helloHint` / `showStatusLine` / `showActivities` / `activitiesDefaultOpen` / `activityLimit` / `placement` /
    `debug` / `onRuntimeReady`（接宿主自己的 store 快照桥与调试句柄）+ `#status` 插槽；
    尺寸走 `--wa-dock-width` / `--wa-dock-height`。
  - **`<HostAssistantChat>`** —— 对话区（多条 textarea + Enter/Shift+Enter、流式「打断」、可点建议、`#empty` 插槽），
    可单独放进宿主自己的布局。
  - **`<HostAssistantActivities>`** —— 「本轮动作」折叠条（缺省收起；点开看 args/result/error）。
  - **不依赖 element-plus**：三者全用原生 `button` / `textarea` + `--wa-*` token（与既有组件一致）。
  - **新增纯逻辑导出**（自写 UI 也能复用同一展示口径）：`formatActivityDetail` / `formatActivityTime` /
    `selectVisibleActivities` / `activityKey` + `ACTIVITY_DETAIL_CLIP` / `ACTIVITY_VISIBLE_LIMIT`。

  两处需要注意的行为：

  - **收起用 `v-show`**（runtime / socket 继续存活，agent 仍能导航）—— 别用 `v-if` 包它。
  - dock 头部的按钮由「清空对话」改为「**新会话**」：调 `startNewSession()`（清消息 + 断开重连 = 服务端新建会话），
    与容器面 `ChatPanel` 的「新会话」语义一致（原先的 `reset` 只清本地消息、服务端上下文仍在）。

  demo 侧同步收敛：`AssistantDock.vue` 退化为薄封装（binding + store 快照桥 + 调试句柄），
  `AssistantChat.vue` 删除；`tokens.css` 补齐 `--wa-panel-bg` / `--wa-text-muted` / `--wa-border-*` /
  `--wa-radius*` / `--wa-error-*` 映射。

- feat(session)!: 会话改为 connection-scoped（会话 = 连接）—— 断开即新会话，并在连接内实现真正的多轮对话

  **破坏性变更**

  - 协议（`@webassistant/protocol`）：
    - `SessionHelloMessage` 删除 `sessionId?`（客户端不再上报、不再持久化任何会话标识）；
    - `SessionReadyMessage` 删除 `resumed`（每次都新建会话，没有"恢复"这个状态）；
    - `AgentSession` 删除 `history`（只写不读的死数据）与 `socketId`（连接作用域后无需绑定/解绑判定），
      随之删除 `ChatTurn` / `ChatTurnRole` 类型。
  - chat-client：
    - `createAgentSocket` 不再读写 `sessionStorage`（`webassistant.sessionId` 键消失）；
    - `connect()` 返回值由 `{ sessionId, resumed }` 改为 `{ sessionId }`；
    - 新增 `AgentSocket.startNewSession()` 与 `AgentSocketOptions.onSessionReset`；`useWebAssistant` / `useAgentChat`
      透出 `startNewSession()`。

  **原因**

  原设计是「会话与连接解耦」（`sessionId` 存 `sessionStorage`、断线重连恢复），但实际运行中它带来的是负收益：

  1. **前后端状态必然发岔** —— 刷新后客户端渲染宿主回到欢迎页（不发 `page.navigated`），服务端却仍保留刷新前的
     `currentPage` / `recentObservations` / `pageExposedKeys`，下一轮 prompt 会告诉模型一个并不存在的"当前页"。
  2. **刷新后旧 run 继续串流，还能并发起第二个 run** —— `activeAgents` 按 sessionId 保活、`rpc.register` 覆盖式注册，
     于是旧 run 的输出继续推到刷新后的页面；此时再发消息会跑起两个并发 Agent，且旧实例的引用被覆盖后**再也 cancel 不掉**。
  3. **"多轮对话"其实不存在** —— `session.history` 只写不读，`new Agent()` 也没带 `initialMessages`，
     每轮都是单轮无记忆对话。也就是说"保持 session"保住的只是陈旧页面上下文，没保住对话本身。

  **改为**

  - **会话 = 连接**：握手即新建、断开即销毁；客户端零持久化（刷新 / 重连 = 全新会话，聊天区清空并提示）；
    多条 WS 连接并存时各自独立会话。
  - **断开即止损**：`handleDisconnect` 依次 abort 在跑的 run → 销毁会话（含清理观察等待）→ 注销 RPC → 释放 agent 实例。
  - **连接内真多轮**：`AgentService` 为每个会话维护一个长驻 `AgentRuntime`（`state.messages` 即对话轨迹，
    含 tool-call / tool-result）；每轮的动态页面上下文（manifest + 规则 + 当前页可用方法 + 最近观察）
    由 SDK 的 `prepareTurn` 投影注入（只影响当次请求、不回写轨迹），并按 `MAX_TURN_MESSAGES`（默认 24）做有界裁剪。
  - **同会话串行**：运行中再次 `chat.send` 会被显式拒绝并回 `chat.error`（SDK 侧也有 "already running" 保护）。
  - `SESSION_TTL_MS` 保留为**僵尸兜底回收**（异常路径未触发 disconnect 时），不再承担"保活"语义。
  - 客户端新增「新会话」入口（内置 `ChatPanel` 标题栏按钮），等价于刷新页面但不必关标签页。

  **迁移**

  - 自定义宿主若曾读取 `session.ready.resumed` 或自行持久化 `sessionId`，直接删除相关逻辑（协议不再提供）；
    旧服务端 + 新客户端、或新服务端 + 旧客户端都能工作（服务端忽略入参 `sessionId`，客户端不读 `resumed`）。
  - 需要"记住上次会话"的场景不再支持：刷新即新会话是本版本的**有意行为**。

- 渲染面（`surface`）与 `createRuntime` 不再各判一次；headless 补齐状态行所需的两项；清理两个从未接线的心跳参数

  - **`surface` 缺省自动推导**（新增纯逻辑 `lib/surface.ts` + 导出 `resolveSurfaceKind`）：
    给了 `createRuntime` ⇒ `host`，否则 ⇒ `container`；显式传入仍优先。
    此前判据散在两处（`WebAssistant.vue` 判渲染区、`useRuntimeHost` 判 init 挂载点），
    只给 `createRuntime` 忘给 `surface:'host'` 会**静默错配**：runtime 实际是 host 面，
    面板却仍渲染一整列空的「渲染区域」；只给 `surface:'host'` 忘给 `createRuntime` 则一路走到 init
    才抛「渲染容器未就绪」（与真实原因对不上）。现在：判据唯一，且显式 host 无 `createRuntime` 时
    `useWebAssistant` 立即抛清晰错误。
  - `useRuntimeHost` / `useWebAssistant` 新增转出 **`navigationSource`**（最近一次导航来源）、
    `useWebAssistant` 新增转出 **`pageExposedKeys`**（当前页 expose key 列表）——
    自写 UI 的宿主（如 demo 的 host dock）此前必须自己 `runtime.on('navigate')` /
    `runtime.on('page-exposed-changed')` 各订阅一遍，现已删除。
  - 移除从未接线的 `agentBase` 与 `forwardPageEvents`（WS 为唯一链路的现状下二者无实现，
    文档里描述的 HTTP/SSE 路径早已退役）。
  - demo `AssistantDock.vue` 因此少写 4 处重复（两个本地 ref + 两个 runtime 订阅），
    且不再显式传 `surface: 'host'`。

### Patch Changes

- host 模式（`surface="host"`）的「无渲染区」改为**紧凑提示条**；样式入口与内嵌高度写进接入文档

  - `WebAssistant`：host 模式不再用**一整列**空面板充当「宿主直连模式」提示 —— 面板落在窄容器里
    （宿主右下角 dock 是 host 模式的主要场景）会把对话区挤到 ~120px。现在 header 下方是一条紧凑提示条
    （模式徽标 + 提示文案 + 加载/打断），错误横幅（`.host-error`）紧跟其后；当前页指示仍保留
    （`pageTitle` 在 header 右侧，宿主关掉 header 时才在提示条里补一份，避免同一句话出现两遍）。
    容器模式（`surface` 缺省）的 DOM 与样式逐字节不变。
  - 顺带把 demo 侧踩到的两件事写进 `docs/INTEGRATION_GUIDE.md §9`：chat-client 是**预构建库**，
    宿主必须自己 `import '@webassistant/chat-client/style.css'`；内嵌面板必须给 `--wa-height`
    （组件根缺省 `height: 100vh`，会被容器 `overflow` 裁掉底部 → 输入栏看不见）。

- 宿主直连（用法 B）两处修复；chat-client 收窄为纯组件库（演示统一到 demo-app）

  - `wc-runtime-vue`：host 模式下**不再拦住宿主自己的路由**。内核守卫此前对宿主的任何导航都调用
    `canNavigate`，而内核只认页面目录 → runtime 存活期间点不进登录页 / 404 / 宿主演示页
    （vue-router 以 NavigationFailure resolve，没有任何报错，表现为「点了没反应」）。
    新增桥选项 `passThroughUnknownRoutes`（host 恒开）：目录外的路由放行且不回流内核；
    容器模式缺省 false，行为逐字节不变。
  - `chat-client`：`debug` 的 `globalThis.__waRuntime` 句柄在卸载时改为「只在当前挂着的还是本实例」
    才删除 —— 同页第二个 runtime（例如 WC 演示页 + 宿主 dock）不会再把仍在运行的实例句柄抹掉。
    同时移除库内自带的 SPA demo（`index.html` / `src/main.ts` / `src/style.css` / `vite.config.ts`
    与 `dev` / `preview` / `build` 脚本）：库只管组件，演示统一在 demo-app 里做。

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @webassistant/protocol@0.3.0
  - @webassistant/wc-runtime-vue@0.5.0
  - @webassistant/wc-runtime-core@0.3.2

## 0.5.0

### Minor Changes

- 258d331: refactor(observe)!: 退役自动网络观测 —— 数据只由调用点显式 `apiBus.report` 上报

  **破坏性变更**

  - 删除 `NetworkObserver`（不再包装 `window.fetch` / `XMLHttpRequest`）与 `CreateRuntimeOptions.observeNetwork`；
    随之删除各类型/句柄上的 `observer` 字段、`network-observation` 事件、`WcActivityKind` 的 `'network'`。
  - 协议删除 `page.network.request|response|error|timeout` 四条客户端消息与 `PageNetwork*` 类型、
    `AgentSession.pendingRequests`；`ObservationMatch` 由 `requestId/method/url` 改为 `source/event/contains`。
  - chat-client 删除 `onNetworkObservation` / `sendObservation`。
  - **数据上报只有一条路**：调用方（宿主 / 页面）在需要的调用点显式 `apiBus.report({ source, data })`；
    **不调 = 零数据出浏览器**（天然 fail-closed，无需维护白名单）。

  **原因**：全量拦截宿主页面的请求（真实站点往往有大量内部接口）会把不相关甚至敏感的数据带出浏览器，
  而靠事后白名单 / 脱敏补救既不可靠（fetch 分支曾漏检黑名单）、也难以维护；同时改写全局 fetch 还带来
  阻塞流式响应、多实例抢占、`stop()` 后残留包装等副作用。

  **其他改动**

  - `apiBus.report()`：`url` 改可选、新增 `source`；返回 `boolean`（false = 当前无人监听）。
  - `apiBus.attach()` 增加**覆盖告警**（单 sink 语义）：业务侧误调 `attach()` 顶掉内核 sink 时立刻可见。
  - **chat-client 转出 `apiBus` / `ApiReport`**：只装面板的宿主（用法 A）不必为了上报再引一个包。
  - `sanitizeData` 从 `observer.ts` 搬到 `sanitize.ts`，并修掉 O(n²) 的体积统计（现为线性、上限更可预期）。
  - runtime 侧对上报数据只做：补 `page`/`at` + 体积/深度硬上限（16KB / 深度 4）+ **可选**的
    `dataSources` 裁剪（命中才裁；未命中即原样透传）。
  - `wait_for_observation` 工具描述与匹配条件改为「等待显式上报的数据 / 页面事件」。

  **迁移**：把原来的自动上报（如 axios 拦截器里统一 `apiBus.report`）改为在**明确的调用点**上报，
  并只传你愿意公开的字段；页面/宿主未调用则 agent 侧不会收到任何业务数据。

### Patch Changes

- Updated dependencies [258d331]
  - @webassistant/wc-runtime-core@0.3.0
  - @webassistant/wc-runtime-vue@0.4.0
  - @webassistant/protocol@0.2.0

## 0.4.1

> 0.4.0 与 0.4.1 是同一份内容：发布时**本地网络侧的代理缓存**把刚上传的 tarball 误报成 404，
> 排查过程中补发了 0.4.1（registry 上两个版本都可用，装 `latest` 即 0.4.1）。

### Patch Changes

- 无代码变更（同 0.4.0）。

## 0.4.0

### Minor Changes

- 7e86e8d: 新增「用法 B：宿主直连」—— agent 直接操作宿主自己的 vue-router，页面在宿主自己的 `<router-view>` 渲染（不编译 WC、不建容器、不做样式隔离）。

  - **wc-runtime-core**：把 runtime 拆成「内核（kernel.ts）+ 渲染面（PageSurface / RuntimeHistory 两个扩展点）」，
    `createRuntime({ surface: 'container' | 'host' })` 选择渲染面；默认 container **行为与解耦前等价**（既有单测断言零改动）。
    容器实现迁入 `surfaceContainer.ts`；manifest 归一化支持宿主批次（`bundle` 可省、`containers` 可空、`tag` 无需含 `-`）；
    新增 `surface` / `hostSurface` / `adopt` 选项，`init(root?)` 允许不传挂载点；`RuntimeHistory` 支持外部历史（委托宿主）。
  - **wc-runtime-vue**：抽出 `routerSync.ts`（guard 前移 / `applying` 防回环 / 回流 commit，两种用法共用一份）；
    新增 `createVueHostSurface()` 与 `createVueHostRuntime()` 及子入口 `@webassistant/wc-runtime-vue/host-router`；
    `RuntimeServicesContext` 新增 `pageProps` 旁路（container 模式恒为空）。
  - **chat-client**：新增 `surface` / `createRuntime` 注入口与 host 模式面板（无渲染区，只显示状态）；
    `useRuntimeHost` 允许无挂载点初始化；单实例约束告警。
  - **protocol / analyzer / vite-plugin-wc**：`wc.pages.json` 的 `container` 变为可选 —— 省略即宿主直连批次，
    analyzer / `wcManifestPlugin` 不再写 `containers` 与 `pages[].bundle`（WC 构建侧仍强制要求 container）；
    `ManifestPage.bundle` 变可选。
  - **demo-app**：新增 `host.html` + `src/host-main.ts` 验收台与 `pnpm dev:host` / `pnpm analyze:host` 脚本。

### Patch Changes

- Updated dependencies [7e86e8d]
  - @webassistant/wc-runtime-core@0.2.0
  - @webassistant/wc-runtime-vue@0.3.0
  - @webassistant/protocol@0.1.1

## 0.3.0

### Minor Changes

- 113da5b: feat(store): 宿主 store → CE 的快照桥（镜像），页面零改动

  宿主 pinia 与批次 pinia 是**两个实例、两份库副本**（连 vue 都是两份），跨副本共享实例的
  响应式依赖收集不互通（页面会「首次能读、之后不更新」）。新增官方通道把宿主 store 的数据
  镜像进页面：

  - `createHostStorePusher({ getRuntime, only? })`（宿主侧，零 vue 依赖，挂在 `@webassistant/wc-runtime-vue/host`）：
    用 pinia 插件自动覆盖所有 store —— 创建即推一次、`$subscribe` 变更即推 `store:<id>` 快照；
    没有宿主 app 时可用 `pusher.push(store)` 手动桥。
  - `createStoreMirror({ only?, twoWay? })`（CE 侧）：容器 `plugins: [createPinia().use(mirror.plugin)]`
    - `setup(ctx) { mirror.attach(ctx) }`，按 store id 把快照 hydrate 进批次同名 store 并持续同步。
  - 附带 `cloneHostState` / `hostStoreKey` / `isHostStoreKey` / `hostStoreIdFromKey` /
    `STORE_PATCH_EVENT` / `applyHostStorePatch`（twoWay 回传用）。
  - 只同步可序列化 `$state`（getter/action/对象身份不过桥）；默认单向（宿主为真相源）。

  chat-client：为上述桥补上宿主侧的 runtime 句柄 —— `useRuntimeHost`/`useWebAssistant` 返回
  `runtime`（框架无关 API：`setState` / `setServices` / `getPageExposed`），`<WebAssistant>` 新增
  `onRuntimeReady` 回调，`mountWebAssistant` 新增 `{ plugins }`（挂载前安装宿主自己的 pinia/插件）。

### Patch Changes

- Updated dependencies [113da5b]
  - @webassistant/wc-runtime-vue@0.2.0

## 0.2.0

### Minor Changes

- 16f7058: **欢迎页（渲染区空态）视觉升级：满屏铺满 + 入场动效 + 图片化能力卡片。**

  - **铺满渲染区**：内置 `WelcomePage` 去掉 640px 窄列居中，改为 `width: 100% / min-height: 100%` 铺满；
    `WebAssistant.vue` 的 `.empty` 改为 `align-items: stretch` + 无内边距，最小空态（`welcome=false`）
    另行包一层 `.empty-fallback` 保持居中。欢迎页 / `#welcome` 插槽内容现在 edge-to-edge 铺满渲染区。
  - **hero 区**：淡雅渐变背景图（自包含 SVG data URI）+ `DotGrid` 点阵动效（`gsap`，鼠标视差 / 点击冲击波）+ `BlurText` 逐词模糊入场欢迎语。hero 有高度上限（`min(46vh, 360px)`），欢迎语异常长时不会撑坏布局。
  - **欢迎语分层（去掉重复内容）**：agent 下发的 `text` 其实是一份「文档」（默认含 `目前我能帮你：` +
    每个能力一条 bullet）。能力清单已渲染成卡片，因此**只取「列表之前的散文」**：首行 → hero 主标题
    （BlurText 动画），列表之前的散文行（≤2 行）→ hero 副标题；**列表引导句与 bullet 一律丢弃**，
    不再在页面上重复一遍（全文仍作为 assistant 消息出现在对话里）。纯逻辑抽到
    `lib/welcome.ts` 的 `splitWelcomeText()`（新增导出，含单测），组件只做响应式封装。
  - **能力卡片图片化**：`TiltedCard` 3D 倾斜 + 按 `cap.tag` 确定性生成的渐变缩略图（自包含 SVG data URI）；
    卡片改为「图片在上 + 标题/描述/示例在下」的流式布局。小标题用 `GradientText` 渐变流动。
  - **新增 vendored 组件**（来自 [Vue Bits](https://vue-bits.dev)，MIT + Commons Clause，见
    `src/vuebits/README.md`）：`BlurText` / `GradientText` / `TiltedCard` / `DotGrid`。上游用 Tailwind
    工具类，本仓库不依赖 Tailwind，已全部改写为原生 CSS。
  - **新增运行时依赖**：`motion-v`（^1.10）、`gsap`（^3.13，含已免费内置的 `InertiaPlugin`）。库产物随之变大
    （`dist/index.js` 约 350 kB / gzip 105 kB；`dist/style.css` 约 11 kB）。
  - **props 契约不变**：`WelcomePageProps`（`text` / `capabilities` / `loading`）与
    `#welcome` 插槽 > `welcome` prop > 内置 `WelcomePage` > `welcome=false` 最小空态的覆盖优先级完全不变。

## 0.1.0

### Minor Changes

- 31df00c: **欢迎页 = 渲染区空态**（runtime 没有渲染子 WC 时渲染区的默认内容）：逻辑对外开放，宿主可整体覆盖。

  - **`wc-runtime-core`**：新增 `Runtime.hasPage`（有当前页 ⇔ 已渲染出子 WC，与 `RuntimeView.tag` 同源；
    `false` 时宿主应展示空态）。`initial: null` 不导航 → 天然 `false`，不再需要宿主自己记「导航过没有」。
  - **`chat-client`**：欢迎页拆三层并全部导出 ——
    - `lib/welcome.ts`（纯逻辑、零依赖、可单测）：`DEFAULT_WELCOME_TEXT`、`resolveWelcomeVariant`
      （`page` / `welcome-loading` / `welcome`）、`resolveWelcomeLoading`、`resolveWelcomeText`、
      `resolveWelcomeCapabilities`（握手载荷优先，本地 manifest 路由兜底）、`resolveWelcomeComponent`。
    - `composables/useWelcomePage.ts`：包成 `{ variant, visible, text, capabilities, loading }`；
      `useWebAssistant()` 以 `welcomePage` 透出（原先 headless 宿主只能自己再抄一遍判空与合并）。
    - `components/WelcomePage.vue`：默认呈现组件（`text` / `capabilities` / `loading`）。
  - **判空改用 runtime 事实**：`useRuntimeHost` 订阅 `view` 事件派生 `currentTag` / `hasPage`，不再用
    `navigate` 事件的粘性布尔（后者只表示「发生过导航」，加载失败不回退，且一旦导航过就再也回不到空态）。
  - **错误与欢迎页解耦**：错误独立成横幅（新增 `--wa-error-*` 主题变量），不再把空态整块替换成一行错误文本
    （旧实现里 `v-if="error"` / `v-else` 让两者互斥，错误一出现欢迎页就消失）。横幅**仅无页时显示**；
    有页面时页面加载失败由容器渲染 `.wa-runtime-error`，其余运行时错误走 `error` ref / `@error` emit。
  - **`loading` 语义修正**：由 `sessionReady` + `manifestSettled` 决定（**失败也算 settle**，不会死转圈），
    不再是「对话中」；刷新瞬间不会误显「暂无可操作页面」。
  - **修复「内置欢迎页永不渲染」**：`welcome` 的运行时 prop 含 `Boolean` 且无 `default` 时，Vue 会把缺省
    cast 成 `false`（runtime-core：`isAbsent && !hasDefault → value = false`）→ 被误判成「宿主关闭了欢迎页」，
    渲染区只剩最小空态。修法：`withDefaults` 显式 `welcome: undefined`（产物核对 `default: void 0`），
    并新增 `resolveWelcomeComponent` 兜住非组件值（`true` / 空串 → 回退内置组件）。
  - **覆盖优先级不变**：`#welcome` 插槽 > `welcome` prop > 内置 `WelcomePage` > `welcome=false` 最小空态；
    `#welcome` 插槽入参升级为**合并后的完整状态**（`WelcomePageSlotProps`）。
  - **`protocol`**：`session.ready.welcome = { text, capabilities[] }`（`WelcomePayload` / `WelcomeCapability`），
    随握手一并下发，供欢迎页渲染能力卡片；缺失时客户端用本地 manifest 路由兜底。
  - **首屏默认不自动打开页面**：`initialPage`（`boolean | string`）显式化；缺省 = 欢迎页先出现。

### Patch Changes

- Updated dependencies [31df00c]
- Updated dependencies [2de5540]
- Updated dependencies [2de5540]
- Updated dependencies [31df00c]
  - @webassistant/protocol@0.1.0
  - @webassistant/wc-runtime-core@0.1.0
  - @webassistant/wc-runtime-vue@0.1.0
