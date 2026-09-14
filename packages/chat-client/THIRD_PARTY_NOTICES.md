# 第三方资源声明（@webassistant/chat-client）

本包内含 **vendored（内联/改写）的第三方组件源码**。

## Vue Bits

- 来源：<https://vue-bits.dev> · <https://github.com/DavidHDev/vue-bits>
- 许可：**MIT + Commons Clause**（见上游 `LICENSE.md`）
- 位置：`src/vuebits/`（`BlurText.vue` / `GradientText.vue` / `TiltedCard.vue` / `DotGrid.vue`）

Commons Clause 限制的是「把本组件本身作为商品出售 / 提供其商业服务」，
**不限制在项目内使用与修改**。本包对其做了如下改动（详见 `src/vuebits/README.md`）：

1. 上游的 Tailwind 工具类 → 原生 CSS（本仓库不依赖 Tailwind）；
2. `TiltedCard` 由「纯图片卡片」改为流式布局 + 默认插槽（承载能力卡片文本），倾斜逻辑保持一致。

若需在本包发布产物中再分发，请一并保留本声明与各组件的来源注释。

## 运行时依赖（npm）

| 包 | 许可 | 用途 |
| --- | --- | --- |
| `motion-v` | MIT | `BlurText` / `GradientText` / `TiltedCard` 的动画 |
| `gsap`（含 `InertiaPlugin`） | GreenSock 标准「免版税」许可 | `DotGrid` 的惯性物理动画 |
