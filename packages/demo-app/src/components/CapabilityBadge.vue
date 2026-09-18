<script setup lang="ts">
// 页面级「能力徽标」：一行小字说明本页演示了 WebAssistant 的哪些能力。
//
// 为什么要它：这是一个**展示应用** —— 每个页面演示什么必须写在页面上（而不是散落在注释与验收文档里），
// 让人一眼看到「这个能力在这页被用到了」，也让 agent 的 prompt 与页面行为对得上。
defineProps<{
  /** 本页演示的能力（短标签，2-4 个字） */
  items: string[]
  /** 可选补充说明（一句话） */
  hint?: string
}>()
</script>

<template>
  <div class="capability">
    <span class="label">本页演示</span>
    <span v-for="item in items" :key="item" class="chip">{{ item }}</span>
    <span v-if="hint" class="hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.capability {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--app-space-2);
  margin: 0 0 var(--app-space-4);
  padding: var(--app-space-2) var(--app-space-3);
  border: 1px dashed #c7d2fe;
  border-radius: var(--app-radius-sm);
  background: var(--app-primary-weak);
  font-size: 12px;
  color: #4338ca;
}
.label {
  font-weight: 600;
}
.chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid #c7d2fe;
  white-space: nowrap;
}
.hint {
  color: #6366f1;
}
</style>
