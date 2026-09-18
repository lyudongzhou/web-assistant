<script setup lang="ts">
// 页面头部：标题 + 描述 + 右侧操作区（各页统一，避免每页自己写一套 header 样式）
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <header class="page-header">
    <div class="titles">
      <h1>{{ title }}</h1>
      <p v-if="description" class="description">{{ description }}</p>
    </div>
    <div class="actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--app-space-4);
  flex-wrap: wrap;
  margin-bottom: var(--app-space-3);
}
.titles h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--app-text);
}
.description {
  margin: var(--app-space-1) 0 0;
  font-size: 12px;
  color: var(--app-text-muted);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--app-space-2);
  flex-wrap: wrap;
}
</style>
