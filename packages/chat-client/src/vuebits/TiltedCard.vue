<!--
  Vue Bits — TiltedCard
  来源：https://vue-bits.dev · https://github.com/DavidHDev/vue-bits
  许可：MIT + Commons Clause（保留原许可；不可将本组件单独售卖）。
  本副本的适配：
    ① 原 Tailwind 工具类 → 本项目原生 CSS；
    ② 图片改为常规流式布局（原版是绝对定位、仅图片卡片），并新增默认插槽
       `<slot />` 位于图片下方，以便承载「能力卡片」的标题 / 描述文本；
    ③ 鼠标跟随倾斜（rotateX / rotateY + spring）逻辑与原版一致。
-->
<template>
  <figure
    ref="cardRef"
    class="tilted-card"
    :style="{ width: containerWidth, height: containerHeight }"
    @mousemove="handleMouse"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <div v-if="showMobileWarning" class="tilted-card-mobile-tip">
      This effect is not optimized for mobile. Check on desktop.
    </div>

    <Motion
      tag="div"
      class="tilted-card-inner"
      :style="{ width: imageWidth }"
      :animate="{ rotateX: rotateXValue, rotateY: rotateYValue, scale: scaleValue }"
      :transition="springTransition"
    >
      <img
        v-if="imageSrc"
        class="tilted-card-image"
        :src="imageSrc"
        :alt="altText"
        :style="{ height: imageHeight }"
      />

      <Motion
        v-if="displayOverlayContent && overlayContent"
        tag="div"
        class="tilted-card-overlay"
      >
        <slot name="overlay" />
      </Motion>

      <div v-if="$slots.default" class="tilted-card-body">
        <slot />
      </div>
    </Motion>

    <Motion
      v-if="showTooltip && captionText"
      tag="figcaption"
      class="tilted-card-caption"
      :animate="{
        x: xValue,
        y: yValue,
        opacity: opacityValue,
        rotate: rotateFigcaptionValue,
      }"
      :transition="tooltipTransition"
    >
      {{ captionText }}
    </Motion>
  </figure>
</template>

<script setup lang="ts">
import { ref, computed, useTemplateRef } from 'vue'
import { Motion } from 'motion-v'

interface TiltedCardProps {
  imageSrc: string
  altText?: string
  captionText?: string
  containerHeight?: string
  containerWidth?: string
  imageHeight?: string
  imageWidth?: string
  scaleOnHover?: number
  rotateAmplitude?: number
  showMobileWarning?: boolean
  showTooltip?: boolean
  overlayContent?: boolean
  displayOverlayContent?: boolean
}

const props = withDefaults(defineProps<TiltedCardProps>(), {
  altText: 'Tilted card image',
  captionText: '',
  containerHeight: 'auto',
  containerWidth: '100%',
  imageHeight: '160px',
  imageWidth: '100%',
  scaleOnHover: 1.03,
  rotateAmplitude: 10,
  showMobileWarning: false,
  showTooltip: false,
  overlayContent: false,
  displayOverlayContent: false,
})

const cardRef = useTemplateRef<HTMLElement>('cardRef')
const xValue = ref(0)
const yValue = ref(0)
const rotateXValue = ref(0)
const rotateYValue = ref(0)
const scaleValue = ref(1)
const opacityValue = ref(0)
const rotateFigcaptionValue = ref(0)
const lastY = ref(0)

const springTransition = computed(() => ({
  type: 'spring' as const,
  damping: 30,
  stiffness: 100,
  mass: 2,
}))

const tooltipTransition = computed(() => ({
  type: 'spring' as const,
  damping: 30,
  stiffness: 350,
  mass: 1,
}))

function handleMouse(e: MouseEvent) {
  if (!cardRef.value) return

  const rect = cardRef.value.getBoundingClientRect()
  const offsetX = e.clientX - rect.left - rect.width / 2
  const offsetY = e.clientY - rect.top - rect.height / 2

  const rotationX = (offsetY / (rect.height / 2)) * -props.rotateAmplitude
  const rotationY = (offsetX / (rect.width / 2)) * props.rotateAmplitude

  rotateXValue.value = rotationX
  rotateYValue.value = rotationY

  xValue.value = e.clientX - rect.left
  yValue.value = e.clientY - rect.top

  const velocityY = offsetY - lastY.value
  rotateFigcaptionValue.value = -velocityY * 0.6
  lastY.value = offsetY
}

function handleMouseEnter() {
  scaleValue.value = props.scaleOnHover
  opacityValue.value = 1
}

function handleMouseLeave() {
  opacityValue.value = 0
  scaleValue.value = 1
  rotateXValue.value = 0
  rotateYValue.value = 0
  rotateFigcaptionValue.value = 0
}
</script>

<style scoped>
.tilted-card {
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  perspective: 800px;
  margin: 0;
}
.tilted-card-mobile-tip {
  position: absolute;
  top: 16px;
  width: 100%;
  text-align: center;
  font-size: 13px;
}
.tilted-card-inner {
  position: relative;
  transform-style: preserve-3d;
  border-radius: 16px;
  background: var(--wa-panel-bg, #fff);
  border: 1px solid var(--wa-border, #e5e7eb);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.07);
  will-change: transform;
}
.tilted-card-image {
  display: block;
  width: 100%;
  height: 160px;
  object-fit: cover;
  border-radius: 15px 15px 0 0;
  will-change: transform;
  transform: translateZ(0);
}
.tilted-card-overlay {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  will-change: transform;
  transform: translateZ(30px);
}
.tilted-card-body {
  padding: 12px 14px;
}
.tilted-card-caption {
  pointer-events: none;
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 4px;
  background: #fff;
  padding: 4px 10px;
  font-size: 10px;
  color: #2d2d2d;
  opacity: 0;
  z-index: 3;
}
@media (max-width: 639px) {
  .tilted-card-mobile-tip,
  .tilted-card-caption {
    display: none;
  }
}
</style>
