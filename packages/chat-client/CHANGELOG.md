# @webassistant/chat-client

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
