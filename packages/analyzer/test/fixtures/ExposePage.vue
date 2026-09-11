<template>
  <div><button @click="refresh">刷新</button></div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ status?: 'paid' | 'all'; page?: number }>()

const status = ref(props.status ?? 'all')

/** 重新拉取当前筛选条件下的数据，返回条数 */
async function refresh(): Promise<number> {
  return 1
}

// —— 分区注释应被忽略 ——
/** 切换筛选状态 */
const setStatus = (next: 'paid' | 'all', keepPage = false): boolean => {
  status.value = next
  return keepPage
}

const exportedAlias = refresh

defineExpose({ refresh, setStatus, exportedAlias, 'renamed-key': setStatus, ...spreadThing })
</script>
