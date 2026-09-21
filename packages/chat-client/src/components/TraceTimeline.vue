<template>
  <!-- 过程区：agent 到底做了什么（步骤 / 思考 / 错误），与结果气泡**分离**。
       这是「思考的过程与结果没有区分的开」的修复面：
         - 默认收起（dock 空间宝贵），标题带步数 / 进行中 / 失败 / 本轮耗时
         - 展开后每步一行，带状态点（✓ / ✗ / ◐）+ 耗时，点开看 args / result
         - runtime 活动（activityBus）与 agent 步骤**合并去重**，同一步不会出现两行
       无内容时整个组件不渲染（纯对话的一轮不该冒出一个空过程区）。 -->
  <section v-if="rows.length || loading" class="trace">
    <div class="trace-head">
      <button class="toggle" type="button" @click="open = !open">
        <span class="chev">{{ open ? '▾' : '▸' }}</span>
        <span class="title">过程</span>
        <span v-if="metaText" class="meta">{{ metaText }}</span>
      </button>
      <span class="spacer"></span>
      <button v-if="showClear && clearable" class="link" type="button" @click="emit('clear')">清空</button>
    </div>

    <!-- 流式期间的活动指示器：**就在这里**，不再另开一个「思考中…」气泡 -->
    <div v-if="loading" class="thinking">
      <span class="dot running">◐</span>
      <span>思考中…</span>
    </div>

    <ol v-if="open && rows.length" class="list">
      <li v-for="row in rows" :key="row.key" class="row" :class="row.type">
        <template v-if="row.type === 'item'">
          <button class="row-main" type="button" @click="toggleDetail(row.key)">
            <span class="dot" :class="dotClass(row.item)">{{ dotText(row.item) }}</span>
            <span class="kind">{{ row.item.kind }}</span>
            <span class="text">{{ row.item.text }}</span>
            <span v-if="row.item.durationMs !== undefined" class="ms">
              {{ formatDuration(row.item.durationMs) }}
            </span>
            <span class="spacer"></span>
            <span class="time">{{ formatActivityTime(row.item.at) }}</span>
          </button>
          <!-- 失败原因**就地显示**：只给一个红 ✗ 要用户点开才知道为什么，等于没说 -->
          <p v-if="row.item.ok === false && row.item.error" class="row-error">{{ row.item.error }}</p>
          <p v-if="openKey === row.key" class="detail">{{ detail(row.item) }}</p>
        </template>

        <p v-else class="block" :class="row.type">
          <span class="block-label">{{ row.type === 'reasoning' ? '思考' : '错误' }}</span>
          <span class="block-text">{{ row.text }}</span>
        </p>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
// 与 <HostAssistantActivities>（旧的「本轮动作」折叠条）的关系：
// 那个只吃 runtime 的 activities（页面级动作），看不到 agent 的对话级步骤（含"在当前页之外"的思考与失败）；
// 这个把 **agent 步骤 + runtime 活动** 合成一条时间轴并去重，是它的超集。
// 纯逻辑（分流 / 配对 / 合并 / 排序）都在 lib/chatTrace.ts，这里只管渲染。
import { computed, ref } from 'vue'
import type { ChatMessage } from '../types.js'
import type { WcActivity } from '../types.js'
import { formatActivityDetail, formatActivityTime } from '../lib/activities.js'
import {
  TRACE_VISIBLE_LIMIT,
  buildTraceRows,
  formatDuration,
  summarizeTrace,
  type TimelineItem,
} from '../lib/chatTrace.js'

const props = withDefaults(
  defineProps<{
    /** 过程条目（`kind`: `step` / `reasoning` / `error`），按发生顺序 */
    items?: ChatMessage[]
    /** runtime 活动（最新在前）—— 与 agent 步骤合并去重后进同一条时间轴 */
    activities?: WcActivity[]
    /** 是否把 runtime 活动并进时间轴（缺省 true；关掉则只看 agent 自己的步骤） */
    includeActivities?: boolean
    /** 初始是否展开（缺省收起：与「本轮动作」一致的取舍） */
    defaultOpen?: boolean
    /** 最多渲染多少行（缺省 60；早期步骤在窄面板里价值低） */
    limit?: number
    /** 本轮总耗时（`chat.done.durationMs`）→ 标题的「共 N 步 · 8.2s」 */
    durationMs?: number
    /** 是否正在进行（显示活动指示器；也是空步骤时仍渲染本组件的原因） */
    loading?: boolean
    /**
     * 是否显示「清空」按钮（缺省 **false**）。
     *
     * 缺省关掉是因为：清空只能清掉 runtime 活动，清不掉对话里的步骤行 ——
     * 按钮摆在「过程」标题旁却只清一半，比没有更让人困惑。
     * 需要「纯活动时间线 + 清空」就用 `<HostAssistantActivities>`（那一份语义是完整的）。
     */
    showClear?: boolean
  }>(),
  {
    items: () => [],
    activities: () => [],
    includeActivities: true,
    defaultOpen: false,
    limit: TRACE_VISIBLE_LIMIT,
    durationMs: undefined,
    loading: false,
    showClear: false,
  },
)

const emit = defineEmits<{ clear: [] }>()

const open = ref(props.defaultOpen)
/** 展开了详情的那一行（以 key 为键；新动作插入后 key 稳定，不会跳到别的行上） */
const openKey = ref<string | null>(null)

const rows = computed(() =>
  buildTraceRows(props.items, props.includeActivities ? props.activities : [], props.limit),
)
/** 标题摘要（步数来自 agent 步骤；耗时来自本轮 run） */
const summary = computed(() => summarizeTrace(props.items, props.durationMs))

const clearable = computed(() => props.items.length > 0 || props.activities.length > 0)

/** 「3 步 · 进行中 · 1 失败 · 8.2s」—— 缺的部分不占位（不留孤零零的分隔符） */
const metaText = computed(() => {
  const parts: string[] = []
  if (summary.value.stepCount) parts.push(`${summary.value.stepCount} 步`)
  if (summary.value.running) parts.push('进行中')
  if (summary.value.failed) parts.push(`${summary.value.failed} 失败`)
  if (summary.value.durationMs !== undefined) parts.push(formatDuration(summary.value.durationMs))
  return parts.join(' · ')
})

function dotText(item: TimelineItem): string {
  if (item.running) return '◐'
  return item.ok === false ? '✗' : '✓'
}

function dotClass(item: TimelineItem): string {
  if (item.running) return 'running'
  return item.ok === false ? 'bad' : 'good'
}

function toggleDetail(key: string): void {
  openKey.value = openKey.value === key ? null : key
}

/**
 * 一行的详情。有 runtime 活动就直接用它的 args/result（信息最全）；
 * 没有（如 `wait_for_observation`）就把 step 自己的字段喂给**同一个** formatter ——
 * 展示口径只有一处（lib/activities.ts），不自造第二套。
 */
function detail(item: TimelineItem): string {
  if (item.activity) return formatActivityDetail(item.activity)
  return formatActivityDetail({
    at: item.at,
    kind: item.kind === 'navigate' ? 'navigate' : 'call',
    name: item.target,
    args: item.args,
    ok: item.ok,
    durationMs: item.durationMs,
    error: item.error,
  })
}
</script>

<style scoped>
.trace {
  border-top: 1px solid var(--wa-border, #e5e7eb);
  background: var(--wa-trace-bg, var(--wa-bg, #f9fafb));
  color: var(--wa-trace-text, var(--wa-text-secondary, #6b7280));
}
.trace-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.chev {
  font-size: 10px;
  color: var(--wa-text-muted, #9ca3af);
}
.title {
  font-size: 12px;
  font-weight: 600;
}
.meta {
  font-size: 11px;
  color: var(--wa-text-muted, #9ca3af);
}
.meta + .meta::before,
.title + .meta::before {
  content: '·';
  margin-right: 6px;
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
.link:hover {
  color: var(--wa-primary, #3b82f6);
}
/* 活动指示器：无内容时也渲染（agent 正在想但还没动手的那段空白期） */
.thinking {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px 6px;
  font-size: 12px;
  color: var(--wa-text-muted, #9ca3af);
}
.list {
  margin: 0;
  padding: 0 0 6px;
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
}
.row {
  padding: 0 12px;
}
.row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--wa-trace-text, var(--wa-text-secondary, #6b7280));
  cursor: pointer;
  text-align: left;
}
.dot {
  flex: 0 0 auto;
  width: 12px;
  text-align: center;
  font-size: 11px;
}
.dot.good {
  color: #16a34a;
}
.dot.bad {
  color: var(--wa-error-text, #b91c1c);
}
.dot.running {
  color: var(--wa-primary, #3b82f6);
}
.kind {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 4px;
  background: #e2e8f0;
  color: #334155;
  font-size: 11px;
}
.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ms,
.time {
  flex: 0 0 auto;
  color: var(--wa-text-muted, #9ca3af);
  font-size: 11px;
}
.detail {
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
/* 失败原因就地显示（不点开也能看见） */
.row-error {
  margin: 0 0 4px 18px;
  color: var(--wa-error-text, #b91c1c);
  font-size: 11px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}
/* 思考 / 错误块：与带状态点的步骤行刻意长得不一样 —— 一眼能分出「在想」和「在做」 */
.block {
  margin: 0 0 6px;
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.block-label {
  display: inline-block;
  margin-right: 6px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  vertical-align: 1px;
}
.block.reasoning {
  color: var(--wa-text-muted, #9ca3af);
  font-style: italic;
}
.block.reasoning .block-label {
  background: var(--wa-border-light, #f3f4f6);
  color: var(--wa-text-secondary, #6b7280);
  font-style: normal;
}
.block.error {
  padding: 6px 8px;
  border: 1px solid var(--wa-error-border, #fecaca);
  border-radius: var(--wa-radius-sm, 6px);
  background: var(--wa-error-bg, #fef2f2);
  color: var(--wa-error-text, #b91c1c);
}
.block.error .block-label {
  background: var(--wa-error-border, #fecaca);
  color: var(--wa-error-text, #b91c1c);
  font-style: normal;
}
</style>
