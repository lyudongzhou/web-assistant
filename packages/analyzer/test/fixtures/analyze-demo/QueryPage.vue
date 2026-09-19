<template>
  <div>{{ ruleName }}</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
/** 按名称过滤 */
const ruleName = computed(() => String(route.query.name || ''))
const page = computed(() => Number(route.query.page || 1))
</script>
