<template>
  <div>
    <!-- 模板里两种读法：$route 全局 + 脚本里绑定的 route -->
    <span>{{ $route.query.from }}</span>
    <span>{{ route.query.templateKey }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const props = defineProps<{ status?: 'paid' | 'all' }>()

const route = useRoute()
const { query: q } = useRoute()

/** 标题里的规则名 */
const ruleName = computed(() => String(route.query.name || ''))

const page = computed(() => Number(route.query.page || 1))
const tab = computed(() => String(q.tab || 'all'))
/** 关键词（解构重命名） */
const { keyword: kw } = route.query
const sort = computed(() => String(route.query['sort'] || ''))
/**
 * 来源标记（多行 JSDoc 的第一行）
 * 续行：开发者向的补充说明，不该进 manifest（routeScan 只取第一行）
 */
const from = computed(() => useRoute().query.from)
const isPaid = computed(() => route.query.flag === 'true')
const status = computed(() => props.status ?? route.query.status)

/** 动态键：无法枚举 */
const byKey = (key: string) => route.query[key]
/** 整块读：无法枚举 */
const all = computed(() => ({ ...route.query }))
const legacy = computed(() => route.params.legacyId)
</script>
