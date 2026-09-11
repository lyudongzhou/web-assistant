<template>
  <!-- @description 3D 力导向图验收页：真实依赖 3d-force-graph + three-render-objects 的运行时 style 注入 -->
  <div style="padding: 16px;">
    <h2 style="margin: 0 0 12px; font-size: 18px;">3D 力导向图（3d-force-graph）</h2>
    <div ref="host" style="width: 100%; height: 420px; border-radius: 8px;"></div>
  </div>
</template>

<script setup lang="ts">
// 验收 styleShim 的第二个（真实）依赖：这两个包会在**模块求值期**用 style-inject
// （rollup-plugin-postcss）往 document.head 注入 <style>：
//   3d-force-graph        → .graph-info-msg / .scene-container .clickable|.grabbable
//   three-render-objects  → .scene-nav-info / .scene-container canvas:focus
// 这些选择器都匹配不到 shadow 树，所以必须靠 styleShim 镜像进容器 shadow root 才生效。
import ForceGraph3D from '3d-force-graph'
import { onBeforeUnmount, onMounted, ref } from 'vue'

const host = ref<HTMLElement | null>(null)
let graph: { _destructor: () => void } | null = null

onMounted(() => {
  if (!host.value) return
  graph = new ForceGraph3D(host.value).backgroundColor('#0b1020').graphData({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    links: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
      { source: 'd', target: 'a' },
    ],
  })
})

onBeforeUnmount(() => {
  graph?._destructor()
  graph = null
})
</script>
