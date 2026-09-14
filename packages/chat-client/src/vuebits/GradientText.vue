<!--
  Vue Bits — GradientText
  来源：https://vue-bits.dev · https://github.com/DavidHDev/vue-bits
  许可：MIT + Commons Clause（保留原许可；不可将本组件单独售卖）。
  本副本的适配：原 Tailwind 工具类 → 本项目原生 CSS；逻辑 / props 保持一致。
-->
<script setup lang="ts">
import { Motion, useAnimationFrame, useMotionValue, useTransform } from 'motion-v'
import { computed, ref, useSlots } from 'vue'

interface GradientTextProps {
  className?: string
  colors?: string[]
  animationSpeed?: number
  showBorder?: boolean
  direction?: 'horizontal' | 'vertical' | 'diagonal'
  pauseOnHover?: boolean
  yoyo?: boolean
}

const props = withDefaults(defineProps<GradientTextProps>(), {
  className: '',
  colors: () => ['#5227FF', '#FF9FFC', '#B19EEF'],
  animationSpeed: 8,
  showBorder: false,
  direction: 'horizontal',
  pauseOnHover: false,
  yoyo: true,
})

const slots = useSlots()
const text = computed(() => (slots.default?.() ?? []).map((v) => v.children).join(''))

const isPaused = ref(false)
const progress = useMotionValue(0)
const elapsedRef = ref(0)
const lastTimeRef = ref<number | null>(null)

const animationDuration = props.animationSpeed * 1000

useAnimationFrame((time) => {
  if (isPaused.value) {
    lastTimeRef.value = null
    return
  }

  if (lastTimeRef.value === null) {
    lastTimeRef.value = time
    return
  }

  const deltaTime = time - lastTimeRef.value
  lastTimeRef.value = time
  elapsedRef.value += deltaTime

  if (props.yoyo) {
    const fullCycle = animationDuration * 2
    const cycleTime = elapsedRef.value % fullCycle

    if (cycleTime < animationDuration) {
      progress.set((cycleTime / animationDuration) * 100)
    } else {
      progress.set(100 - ((cycleTime - animationDuration) / animationDuration) * 100)
    }
  } else {
    // Continuously increase position for seamless looping
    progress.set((elapsedRef.value / animationDuration) * 100)
  }
})

const backgroundPosition = useTransform(progress, (p) => {
  if (props.direction === 'horizontal') {
    return `${p}% 50%`
  } else if (props.direction === 'vertical') {
    return `50% ${p}%`
  } else {
    // For diagonal, move only horizontally to avoid interference patterns
    return `${p}% 50%`
  }
})

const handleMouseEnter = () => {
  if (props.pauseOnHover) isPaused.value = true
}

const handleMouseLeave = () => {
  if (props.pauseOnHover) isPaused.value = false
}

const gradientAngle = computed(() =>
  props.direction === 'horizontal'
    ? 'to right'
    : props.direction === 'vertical'
      ? 'to bottom'
      : 'to bottom right',
)

// Duplicate first color at the end for seamless looping
const gradientColors = computed(() => [...props.colors, props.colors[0]].join(', '))

const gradientStyle = computed(() => ({
  backgroundImage: `linear-gradient(${gradientAngle.value}, ${gradientColors.value})`,
  backgroundSize:
    props.direction === 'horizontal'
      ? '300% 100%'
      : props.direction === 'vertical'
        ? '100% 300%'
        : '300% 300%',
  backgroundRepeat: 'repeat',
}))
</script>

<template>
  <Motion
    tag="div"
    class="gradient-text"
    :class="[className, showBorder && 'gradient-text--bordered']"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <Motion
      v-if="showBorder"
      tag="div"
      class="gradient-text-border"
      :style="{ ...gradientStyle, backgroundPosition }"
    >
      <div class="gradient-text-border-mask" />
    </Motion>

    <Motion
      tag="div"
      class="gradient-text-fill"
      :style="{
        ...gradientStyle,
        backgroundPosition,
        WebkitBackgroundClip: 'text',
      }"
    >
      {{ text }}
    </Motion>
  </Motion>
</template>

<style scoped>
.gradient-text {
  position: relative;
  margin: 0;
  display: flex;
  max-width: fit-content;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 1.25rem;
  font-weight: 500;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: box-shadow 0.5s;
  overflow: hidden;
  cursor: pointer;
}
.gradient-text--bordered {
  padding: 4px 8px;
}
.gradient-text-border {
  z-index: 0;
  position: absolute;
  inset: 0;
  border-radius: 1.25rem;
  pointer-events: none;
}
.gradient-text-border-mask {
  z-index: -1;
  position: absolute;
  background: #000;
  border-radius: 1.25rem;
  width: calc(100% - 2px);
  height: calc(100% - 2px);
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
.gradient-text-fill {
  display: inline-block;
  z-index: 2;
  position: relative;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}
</style>
