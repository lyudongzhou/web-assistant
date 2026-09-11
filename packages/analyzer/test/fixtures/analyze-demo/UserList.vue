<template><div /></template>

<script setup lang="ts">
/** 刷新列表，返回条数 */
function refresh(): number {
  return 1
}

const emit = defineEmits(['search'])

defineProps({ keyword: { type: String, default: '' } })

defineExpose({ refresh })
</script>
