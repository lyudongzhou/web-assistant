<script setup lang="ts">
// 数据状态外壳：把「加载中 / 出错 / 空」三态收敛到一处。
//
// 为什么要它：以前各页各写一套 `v-if="loading"` + `catch {}`（后者会把 500 静默吞掉，
// 页面看着只是「空」—— 这正是「数据没到 agent」最容易被误判的原因）。
// 这里强制把错误显示出来，并给一个重试入口。
withDefaults(
  defineProps<{
    loading?: boolean
    /** 错误文案（非空即显示错误态；页面应把 catch 到的 message 传进来） */
    error?: string
    /** 是否空态（加载完成 + 无错误 + 数据为空） */
    empty?: boolean
    emptyText?: string
  }>(),
  { loading: false, error: '', empty: false, emptyText: '暂无数据' },
)

defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="loading" class="state loading">加载中…</div>
  <div v-else-if="error" class="state error">
    <span>加载失败：{{ error }}</span>
    <el-button size="small" @click="$emit('retry')">重试</el-button>
  </div>
  <div v-else-if="empty" class="state empty">{{ emptyText }}</div>
  <slot v-else />
</template>

<style scoped>
.state {
  display: flex;
  align-items: center;
  gap: var(--app-space-3);
  padding: var(--app-space-4);
  border-radius: var(--app-radius-sm);
  font-size: 13px;
}
.loading {
  color: var(--app-text-muted);
  background: var(--app-surface);
  border: 1px solid var(--app-border);
}
.error {
  color: var(--app-danger);
  background: #fef2f2;
  border: 1px solid #fecaca;
}
.empty {
  color: var(--app-text-muted);
  background: var(--app-surface);
  border: 1px dashed var(--app-border);
  justify-content: center;
}
</style>
