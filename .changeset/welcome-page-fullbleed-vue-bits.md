---
'@webassistant/chat-client': minor
---

**欢迎页（渲染区空态）视觉升级：满屏铺满 + 入场动效 + 图片化能力卡片。**

- **铺满渲染区**：内置 `WelcomePage` 去掉 640px 窄列居中，改为 `width: 100% / min-height: 100%` 铺满；
  `WebAssistant.vue` 的 `.empty` 改为 `align-items: stretch` + 无内边距，最小空态（`welcome=false`）
  另行包一层 `.empty-fallback` 保持居中。欢迎页 / `#welcome` 插槽内容现在 edge-to-edge 铺满渲染区。
- **hero 区**：淡雅渐变背景图（自包含 SVG data URI）+ `DotGrid` 点阵动效（`gsap`，鼠标视差 / 点击冲击波）
  + `BlurText` 逐词模糊入场欢迎语。hero 有高度上限（`min(46vh, 360px)`），欢迎语异常长时不会撑坏布局。
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
