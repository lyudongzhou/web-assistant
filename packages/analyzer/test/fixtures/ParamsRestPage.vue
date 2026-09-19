<template>
  <span>{{ keyword }}</span>
</template>

<script setup lang="ts">
// params 通道的「无法枚举键」两种读法：剩余属性 + 动态键。
// 用来锁死诊断文案：这两条不能指向 WcPageEntry 里不存在的「params 显式声明字段」。
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
/** 剩余属性读 params */
const { ...rest } = route.params
/** 动态键读 params */
const byKey = (key: string) => route.params[key]
const keyword = computed(() => String(route.query.keyword || ''))
</script>
