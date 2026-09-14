# vendored：Vue Bits 组件

本目录下的组件来自 **[Vue Bits](https://vue-bits.dev)**（源码仓库：[DavidHDev/vue-bits](https://github.com/DavidHDev/vue-bits)），
用于 `components/WelcomePage.vue` 的欢迎页动效。

| 组件 | 用途 | 上游依赖 |
| --- | --- | --- |
| `BlurText.vue` | 欢迎语逐词模糊浮现 | `motion-v` |
| `GradientText.vue` | 「我能帮你」小标题渐变流动 | `motion-v` |
| `TiltedCard.vue` | 能力卡片 3D 倾斜 + 图片缩略图 | `motion-v` |
| `DotGrid.vue` | hero 背景点阵（鼠标视差 / 点击冲击波） | `gsap`（含 `InertiaPlugin`） |

## 许可

Vue Bits 采用 **MIT + Commons Clause** 许可。Commons Clause 限制的是**把组件本身当作商品转售**，
并不限制在项目内使用 / 修改。使用本目录组件时请保留本说明与各文件顶部的来源注释。

## 相对上游的改动（本副本）

1. **去掉 Tailwind**：上游用 Tailwind 工具类，本项目不依赖 Tailwind，全部改写为原生 CSS（在各自 `<style scoped>` 内）。
2. **TiltedCard 结构调整**：上游是「绝对定位图片 + overlay」的纯图片卡片；本副本改为常规流式布局，
   新增默认插槽（图片下方）以承载能力卡片的标题 / 描述文本；倾斜（`rotateX/rotateY` + spring）逻辑保持一致。
3. 组件 props / 动画参数尽量与上游保持一致；仅默认值按本场景微调（见各文件 `withDefaults`）。
