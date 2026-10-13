<template>
  <!-- host 模式（宿主直连）**开箱即用**的助手悬浮窗：接线 + 壳 + 对话 + 状态行 + 动作时间线都在里面。
       宿主只需给 `createRuntime`（见 HostAssistantDockProps 的用法示例）。

       ⚠️ 收起时用 `v-show` 而不是 `v-if`：runtime / socket 继续存活 —— agent 仍能导航，
          会话也不会丢（`v-if` 会把面板连同 runtime 一起卸载）。 -->
  <div class="dock" :class="placement">
    <section v-show="open" class="panel">
      <header class="head">
        <span class="dot" :class="wsStatus"></span>
        <strong class="title">{{ title }}</strong>
        <span v-if="badge" class="badge">{{ badge }}</span>
        <span class="spacer"></span>
        <button class="link" type="button" :disabled="!canGoBack" @click="back()">← 返回</button>
        <button class="link" type="button" @click="startNewSession()">新会话</button>
        <button class="link" type="button" @click="open = false">收起</button>
      </header>

      <div v-if="showStatusLine" class="status">
        <span class="chip" :class="wsStatus">连接：{{ WS_TEXT[wsStatus] }}</span>
        <span class="chip" :class="{ hot: navigationSource === 'agent' }">
          导航：{{ navigationSource ?? '—' }}
        </span>
        <span class="chip" :class="{ hot: status === 'ready' }">runtime：{{ status }}</span>
        <span class="chip wide" :title="pageExposedKeys.join('、')">
          当前页：{{ pageTitle || currentTag || '（空态）' }} · expose {{ pageExposedKeys.length }}
        </span>
        <slot name="status" />
      </div>

      <p v-if="error" class="alert">{{ error.message }}</p>

      <HostAssistantChat
        class="body"
        :messages="messages"
        :loading="loading"
        :placeholder="placeholder"
        :markdown="markdown"
        :suggestions="suggestList"
        :hello-title="helloTitle"
        :hello-hint="helloHint"
        :activities="activities"
        :show-trace="showActivities"
        :trace-default-open="activitiesDefaultOpen"
        :trace-duration-ms="traceSummary.durationMs"
        :plan="plan"
        :ask="ask"
        :mode="mode"
        @send="onSend"
        @cancel="cancel"
        @approve-plan="onApprovePlan"
        @revision-open="onRevisionOpen"
        @revision-input="updatePlanDraft"
        @revision-cancel="cancelPlanRevision"
        @revise="onRevise"
        @replan="onReplan"
        @step-done="onStepDone"
        @answer="onAnswer"
        @change-mode="onModeChange"
      />
    </section>

    <button v-show="!open" class="toggle" type="button" @click="open = true">
      <span class="dot"></span>
      {{ openLabel }}
    </button>
  </div>
</template>

<script setup lang="ts">
// 分工：会话/状态/事件编排放这里（chat-client 的 headless 层），UI 全在子组件里。
//   HostAssistantChat       对话区（可单独复用）—— 内部按 kind 分流「结果气泡 / 过程区」
//   TraceTimeline           过程区（步骤 / 思考 / 错误 + runtime 活动合并去重，可单独复用）
//   HostAssistantActivities 纯 runtime 活动折叠条（带「清空」，可单独复用）
// 宿主想更自由：用 `useWebAssistant()`（headless）或这些子组件自己拼。
import { computed, ref, watch } from 'vue'
import type { AgentMode } from '@webassistant/protocol'
import HostAssistantChat from './HostAssistantChat.vue'
import { useWebAssistant } from '../composables/useWebAssistant.js'
import type { AgentSocketState } from '../lib/agentSocket.js'
import type {
  HostAssistantDockProps,
  PageChangeInfo,
  PageEventPayload,
  RuntimeErrorInfo,
} from '../types.js'

const props = withDefaults(defineProps<HostAssistantDockProps>(), {
  services: undefined,
  wsBase: '/ws',
  title: 'WebAssistant',
  badge: '宿主直连',
  defaultOpen: true,
  openLabel: '打开助手',
  placeholder: '描述你想做什么…',
  markdown: true,
  suggestions: undefined,
  showStatusLine: true,
  showActivities: true,
  activitiesDefaultOpen: false,
  activityLimit: undefined,
  placement: 'bottom-right',
  debug: false,
  onRuntimeReady: undefined,
})

const emit = defineEmits<{
  (event: 'page-change', info: PageChangeInfo): void
  (event: 'page-event', payload: PageEventPayload): void
  (event: 'error', error: RuntimeErrorInfo): void
}>()

const WS_TEXT: Record<AgentSocketState, string> = {
  connected: '已连接',
  connecting: '连接中…',
  disconnected: '未连接',
}

const open = ref(props.defaultOpen)

// 用错时的早报错：dock 的 runtime 必须由宿主注入。漏传会一路走到「渲染容器未就绪」
// （因为渲染面退化成 container 而 dock 没有面板内挂载点），那个信息对不上真实原因。
if (typeof props.createRuntime !== 'function') {
  throw new Error(
    '[HostAssistantDock] 缺少 createRuntime —— 宿主直连的 runtime 由宿主注入：' +
      'const { createRuntime } = createVueHostRuntimeBinding({ router, app, services })',
  )
}

const {
  messages,
  loading,
  send,
  sendWith,
  confirmPlan,
  completeStep,
  beginPlanRevision,
  updatePlanDraft,
  cancelPlanRevision,
  revisePlan,
  replan,
  cancel,
  startNewSession,
  wsStatus,
  error,
  activities,
  status,
  currentTag,
  pageTitle,
  canGoBack,
  back,
  pageExposedKeys,
  navigationSource,
  routes,
  traceSummary,
  mode,
  plan,
  ask,
} = useWebAssistant({
  wsBase: props.wsBase,
  // `createRuntime` 一旦提供，渲染面缺省即推导为 'host'（见 lib/surface.ts）——
  // dock 不需要 host 面的渲染区，所以不碰 mountEl。
  createRuntime: props.createRuntime,
  services: props.services,
  activityLimit: props.activityLimit,
  debug: props.debug,
  onRuntimeReady: (runtime) => props.onRuntimeReady?.(runtime),
  onPageChange: (info) => emit('page-change', info),
  onPageEvent: (payload) => emit('page-event', payload),
  onError: (info) => emit('error', info),
})

/**
 * 空态建议：宿主没给就**从页面目录推**（「打开『工作台』」×3）——
 * 比写死几句通用文案有用，也不需要宿主为了用这个 dock 专门配一份文案。
 * 传 `suggestions: []` 可显式关掉建议区。
 */
const suggestList = computed<string[]>(() => {
  if (props.suggestions) return props.suggestions
  return routes.value.slice(0, 3).map((route) => `打开「${route.title ?? route.tag}」`)
})

// ── 回合边界（模式 / 计划 / 提问）的接线 ───────────────────────────────────
//
// dock 只做"数据进、事件出"的转译：卡片与模式切换的 UI 状态都在 useAgentChat（lib/turnState.ts）里，
// 这里只把子组件的事件翻成对 socket 的调用。

/** 用户选的模式 —— 只在**下一轮**随 chat.send 下发（不打断正在跑的一轮） */
const selectedMode = ref<AgentMode>('auto')

// 服务端回传的 requested 是权威值（可能是 MODE_DEFAULT 回落的结果）：跟上它，
// 否则用户点了「直接执行」之后、服务端其实还在 auto 时，dock 会以为"已经同步了"而不带 mode。
watch(
  () => mode.value?.requested,
  (requested) => {
    if (requested) selectedMode.value = requested
  },
)

/** 发送时带上模式选择（与服务端当前值不同才带，避免每轮都塞一遍） */
function onSend(text: string): void {
  const current = mode.value?.requested ?? 'auto'
  if (selectedMode.value !== current) sendWith(text, { mode: selectedMode.value })
  else send(text)
}

/** 模式切换：只记下来，不立刻发请求（用户往往接着就要说做什么） */
function onModeChange(next: AgentMode): void {
  selectedMode.value = next
}

/** 计划卡「开始执行」：带 planId 的一轮（服务端据此批准计划并放开页面操作门禁） */
function onApprovePlan(card: Parameters<typeof confirmPlan>[0]): void {
  confirmPlan(card)
}

/** 计划卡「修改计划」：展开卡内输入框（草稿态在 `lib/turnState.ts`，这里只转发） */
function onRevisionOpen(): void {
  const card = plan.value
  if (card) beginPlanRevision(card.message.planId)
}

/**
 * 计划卡「提交修改」：把用户写下的修改意见作为**对当前计划的修订**发出。
 *
 * 与「重新生成计划」的区别就在这里：这条消息带 `revisePlanId`，服务端据此把本轮标成修订轮，
 * 模型用 `revise_plan` 在本计划上增量合并 —— 未改动的步骤保留原 step id 与完成状态，
 * planId 不变、进度不丢。以前只有一个「重新规划」按钮、发的是固定文案，
 * 结果必然是"推倒重来 + 进度清零"。
 */
function onRevise(): void {
  const card = plan.value
  if (!card) return
  revisePlan(card.draft ?? '', card)
}

/**
 * 计划卡「重新生成计划」：推倒重来（全量重规划）。
 * 仍保留这条路径 —— 有时用户就是想要另一套方案，而不是在原方案上改。
 */
function onReplan(): void {
  replan()
}

/**
 * 计划卡「我已完成 / 我已重做，下一步」（人工步骤）：把"这一步我在页面上做完了"交回服务端。
 *
 * 服务端据此把该步骤标 `done` 并起一轮，模型**先校验**再继续（校验不过会用 handoff_step
 * 带 issue 让用户重做）。客户端不本地推进步骤状态 —— 完成由服务端 `chat.plan` 权威下发。
 */
function onStepDone(stepId: string): void {
  completeStep(plan.value ?? undefined, stepId)
}

/** 问题卡选项被点：带 questionId 发送（服务端把该问题标记为已回答） */
function onAnswer(text: string, questionId: string): void {
  sendWith(text, { questionId })
}
</script>


<style scoped>
.dock {
  position: fixed;
  bottom: 20px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif;
  font-size: 12px;
}
.dock.bottom-right {
  right: 20px;
  align-items: flex-end;
}
.dock.bottom-left {
  left: 20px;
  align-items: flex-start;
}
.dock * {
  box-sizing: border-box;
}
.panel {
  display: flex;
  flex-direction: column;
  /* 尺寸走 CSS 变量：宿主在自己的样式里覆盖即可（--wa-dock-width / --wa-dock-height） */
  width: var(--wa-dock-width, min(420px, calc(100vw - 48px)));
  height: var(--wa-dock-height, min(640px, calc(100vh - 120px)));
  overflow: hidden;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: var(--wa-radius, 8px);
  background: var(--wa-panel-bg, #fff);
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--wa-border-light, #f3f4f6);
  background: var(--wa-bg, #f9fafb);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--wa-text-muted, #9ca3af);
}
.dot.connected,
.toggle .dot {
  background: var(--wa-primary, #3b82f6);
}
.dot.connecting {
  background: #f59e0b;
}
.title {
  font-size: 13px;
}
.badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wa-primary, #3b82f6) 12%, transparent);
  color: var(--wa-primary, #3b82f6);
  font-size: 11px;
  white-space: nowrap;
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
  white-space: nowrap;
}
.link:hover:not(:disabled) {
  color: var(--wa-primary, #3b82f6);
}
.link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--wa-border-light, #f3f4f6);
}
.chip {
  padding: 1px 8px;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: 999px;
  background: var(--wa-bg, #f9fafb);
  color: var(--wa-text-secondary, #6b7280);
  font-size: 11px;
  white-space: nowrap;
}
.chip.hot {
  border-color: var(--wa-primary, #3b82f6);
  color: var(--wa-primary, #3b82f6);
  font-weight: 600;
}
.chip.connecting {
  color: #b45309;
}
.chip.wide {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.alert {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--wa-error-border, #fecaca);
  background: var(--wa-error-bg, #fef2f2);
  color: var(--wa-error-text, #b91c1c);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}
.body {
  flex: 1;
  min-height: 0;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: 999px;
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text-secondary, #6b7280);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.14);
}
.toggle:hover {
  border-color: var(--wa-primary, #3b82f6);
  color: var(--wa-primary, #3b82f6);
}
@media (max-width: 720px) {
  .dock.bottom-right,
  .dock.bottom-left {
    left: 12px;
    right: 12px;
    align-items: stretch;
  }
}
</style>

