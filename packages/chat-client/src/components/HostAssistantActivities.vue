<template>
  <!-- 「本轮动作」：agent 实际执行了什么（call / navigate / data / emit / error）。
       这是本项目的核心卖点 —— 让「助手真在操作你的页面」看得见，而不是只说「我帮你打开了」。 -->
  <section class="acts">
    <div class="acts-head">
      <span class="acts-title">本轮动作</span>
      <span class="acts-count">{{ activities.length }}</span>
      <span class="spacer"></span>
      <button class="link" type="button" :disabled="!activities.length" @click="emit('clear')">
        清空
      </button>
      <button class="link" type="button" @click="open = !open">{{ open ? '收起' : '展开' }}</button>
    </div>

    <ul v-if="open" class="acts-list">
      <li v-if="!visible.length" class="act empty">暂无动作</li>
      <li
        v-for="(activity, index) in visible"
        :key="`${activityKey(activity)}#${index}`"
        class="act"
        :class="[activity.kind, { agent: activity.origin === 'agent' }]"
      >
        <button class="act-main" type="button" @click="toggle(activity.at)">
          <span class="act-kind">{{ activity.kind }}</span>
          <span class="act-name">{{ activity.name ?? '—' }}</span>
          <span v-if="activity.durationMs !== undefined" class="act-meta">{{ activity.durationMs }}ms</span>
          <span v-if="activity.ok === false" class="act-bad">失败</span>
          <span class="spacer"></span>
          <span class="act-time">{{ formatActivityTime(activity.at) }}</span>
        </button>
        <p v-if="openAt === activity.at" class="act-detail">{{ formatActivityDetail(activity) }}</p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// 与容器面的「执行监视」面板（ActivityLog）的分工：那个是深色日志台，横向铺得开；
// 这个是**窄 dock 里的折叠条**（缺省收起、一行一条、点开看 args/result/error），两者数据同源
// （activityBus），只是密度不同 —— 所以是两个组件而不是一个加 prop。
import { computed, ref } from 'vue'
import type { WcActivity } from '../types.js'
import {
  ACTIVITY_VISIBLE_LIMIT,
  activityKey,
  formatActivityDetail,
  formatActivityTime,
  selectVisibleActivities,
} from '../lib/activities.js'

const props = withDefaults(
  defineProps<{
    /** 活动时间线（最新在前） */
    activities?: WcActivity[]
    /** 初始是否展开（缺省收起：dock 空间宝贵） */
    defaultOpen?: boolean
    /** 最多渲染多少条（缺省 40；缓冲上限由 activityBus / `activityLimit` 决定） */
    limit?: number
  }>(),
  {
    activities: () => [],
    defaultOpen: false,
    limit: ACTIVITY_VISIBLE_LIMIT,
  },
)

const emit = defineEmits<{ clear: [] }>()

const open = ref(props.defaultOpen)
/** 展开详情的那条动作（以 `at` 为键；同一毫秒内极少冲突） */
const openAt = ref<number | null>(null)

/**
 * ⚠️ 用 `slice` 而不是 `filter + slice`：最新在前，取前 N 条即「最近 N 条」。
 * 注意不能按 index 做展开键 —— 新动作插入后索引会整体后移，展开的详情会跳到另一条上。
 */
const visible = computed(() => selectVisibleActivities(props.activities, props.limit))

function toggle(at: number): void {
  openAt.value = openAt.value === at ? null : at
}
</script>

<style scoped>
.acts {
  border-top: 1px solid var(--wa-border, #e5e7eb);
  background: var(--wa-bg, #f9fafb);
}
.acts-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
}
.acts-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--wa-text-secondary, #6b7280);
}
.acts-count {
  padding: 0 6px;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: 999px;
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text-muted, #9ca3af);
  font-size: 11px;
}
.spacer {
  flex: 1;
}
.link {
  font: inherit;
  font-size: 12px;
  padding: 2px 4px;
  border: 0;
  background: none;
  color: var(--wa-text-secondary, #6b7280);
  cursor: pointer;
}
.link:hover:not(:disabled) {
  color: var(--wa-primary, #3b82f6);
}
.link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.acts-list {
  margin: 0;
  padding: 0 0 6px;
  list-style: none;
  max-height: 168px;
  overflow-y: auto;
}
.act {
  padding: 0 12px;
}
.act.empty {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--wa-text-muted, #9ca3af);
}
.act-main {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--wa-text-secondary, #6b7280);
  cursor: pointer;
  text-align: left;
}
.act-kind {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 4px;
  background: #e2e8f0;
  color: #334155;
  font-size: 11px;
}
.act.call .act-kind {
  background: #dcfce7;
  color: #15803d;
}
.act.navigate .act-kind {
  background: #e0e7ff;
  color: #4338ca;
}
.act.data .act-kind {
  background: #fef3c7;
  color: #b45309;
}
.act.error .act-kind {
  background: #fee2e2;
  color: #b91c1c;
}
.act-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* agent 亲自调用的那一行高亮 —— 「这不是页面自己刷的」 */
.act.agent .act-name {
  color: var(--wa-primary, #3b82f6);
  font-weight: 600;
}
.act-meta,
.act-time {
  flex: 0 0 auto;
  color: var(--wa-text-muted, #9ca3af);
  font-size: 11px;
}
.act-bad {
  flex: 0 0 auto;
  color: var(--wa-error-text, #b91c1c);
  font-size: 11px;
}
.act-detail {
  margin: 0 0 4px;
  padding: 6px 8px;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: var(--wa-radius-sm, 6px);
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text-secondary, #6b7280);
  font-size: 11px;
  line-height: 1.6;
  word-break: break-all;
  white-space: pre-wrap;
}
</style>
