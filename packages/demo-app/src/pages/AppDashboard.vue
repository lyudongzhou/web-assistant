<template>
  <!-- @description 数据看板页，展示用户总数、今日活跃、订单数、转化率等统计指标 -->
  <div style="padding: 16px;">
    <h2 style="margin: 0 0 16px; font-size: 18px;">数据看板</h2>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px;">
      <el-card v-for="c in cards" :key="c.label" shadow="hover">
        <div style="font-size: 24px; font-weight: 700;">{{ c.value }}</div>
        <div style="font-size: 13px; color: #909399; margin-top: 8px;">{{ c.label }}</div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'

interface StatCard {
  label: string
  value: string | number
}

const props = defineProps({
  // 外部可注入统计指标；不传则用内置 mock
  stats: { type: Array as PropType<StatCard[]>, default: () => [] },
})

const defaultStats: StatCard[] = [
  { label: '用户总数', value: 128 },
  { label: '今日活跃', value: 42 },
  { label: '订单数', value: 356 },
  { label: '转化率', value: '12.5%' },
]

const cards = computed(() => (props.stats.length ? props.stats : defaultStats))
</script>

