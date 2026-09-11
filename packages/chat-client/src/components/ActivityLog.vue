<template>
  <div class="activity-log">
    <div class="panel-title log-title">
      <span>执行监视<span class="count">{{ visible.length }}</span></span>
      <label class="filter">
        <input v-model="onlyCalls" type="checkbox" />
        只看调用
      </label>
      <button class="clear-btn" :disabled="!activities.length" @click="emit('clear')">清空</button>
    </div>

    <div class="log-body">
      <p v-if="!visible.length" class="empty-tip">
        暂无活动<br />
        <span class="hint">页面导航 / 方法调用 / 事件 / 数据上报会实时出现在这里</span>
      </p>

      <div v-for="(activity, index) in visible" :key="`${activity.at}-${index}`" class="row">
        <div class="meta">
          <span class="time">{{ formatTime(activity.at) }}</span>
          <span class="badge" :class="activity.kind">{{ activity.kind }}</span>
          <span v-if="activity.tag" class="tag">{{ activity.tag }}</span>
          <span v-if="activity.name" class="name">{{ activity.name }}</span>
          <span v-if="activity.origin === 'agent'" class="origin">agent</span>
          <span v-if="typeof activity.durationMs === 'number'" class="ms">{{ activity.durationMs }}ms</span>
        </div>
        <div v-if="detail(activity)" class="detail" :class="{ failed: activity.ok === false }">
          {{ detail(activity) }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { WcActivity } from '../types.js'

const props = withDefaults(
  defineProps<{
    /** 活动时间线（最新在前） */
    activities?: WcActivity[]
    /** 最多渲染多少条，缺省 200；缓冲本身由宿主/activityBus 限制 */
    limit?: number
  }>(),
  {
    activities: () => [],
    limit: 200,
  },
)

const emit = defineEmits<{ (event: 'clear'): void }>()

const onlyCalls = ref(false)

const visible = computed(() => {
  const list = onlyCalls.value ? props.activities.filter((a) => a.kind === 'call') : props.activities
  return list.slice(0, props.limit)
})

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 行内详情：失败优先显示 error，否则拼 args / 返回值（截断到 ~140 字） */
function detail(activity: WcActivity): string {
  if (activity.ok === false) return activity.error ?? '失败'
  const parts: string[] = []
  if (activity.args !== undefined) parts.push(`args ${compact(activity.args)}`)
  if (activity.result !== undefined) parts.push(`→ ${compact(activity.result)}`)
  return parts.join(' ')
}

function compact(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) return String(value)
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}
</script>

<style scoped>
.activity-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--wa-log-bg, #111827);
  color: var(--wa-log-text, #d1fae5);
}
.log-title {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--wa-log-bg, #111827);
  border-bottom: 1px solid var(--wa-log-border, #374151);
  color: var(--wa-log-text, #d1fae5);
}
.count {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 400;
  border-radius: 999px;
  background: var(--wa-log-border, #374151);
  color: var(--wa-log-muted, #9ca3af);
}
.filter {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 400;
  color: var(--wa-log-muted, #9ca3af);
  cursor: pointer;
}
.clear-btn {
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 400;
  border: 1px solid var(--wa-log-border, #374151);
  border-radius: var(--wa-radius-sm, 6px);
  background: transparent;
  color: var(--wa-log-text, #d1fae5);
  cursor: pointer;
}
.clear-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.log-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
}
.empty-tip {
  margin: 24px 4px;
  color: var(--wa-log-muted, #9ca3af);
}
.empty-tip .hint {
  font-size: 10px;
  opacity: 0.8;
}
.row {
  padding: 4px 0;
  border-bottom: 1px dashed var(--wa-log-border, #374151);
}
.row:last-child {
  border-bottom: none;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.time {
  color: var(--wa-log-muted, #9ca3af);
}
.badge {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--wa-log-border, #374151);
  color: var(--wa-log-text, #d1fae5);
}
/* call 是「真正执行了什么」——高亮；error 用红 */
.badge.call {
  background: #2563eb;
  color: #fff;
}
.badge.error {
  background: #b91c1c;
  color: #fff;
}
.badge.navigate {
  background: #4b5563;
}
.tag {
  color: #fcd34d;
}
.name {
  color: var(--wa-log-text, #d1fae5);
  font-weight: 600;
}
.origin {
  padding: 0 4px;
  border-radius: 3px;
  background: #7c3aed;
  color: #fff;
  font-size: 10px;
}
.ms {
  color: var(--wa-log-muted, #9ca3af);
}
.detail {
  margin-top: 1px;
  padding-left: 2px;
  color: var(--wa-log-muted, #9ca3af);
  word-break: break-all;
}
.detail.failed {
  color: #fca5a5;
}
</style>
