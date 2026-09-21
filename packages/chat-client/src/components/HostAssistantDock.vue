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
        :suggestions="suggestList"
        :hello-title="helloTitle"
        :hello-hint="helloHint"
        :activities="activities"
        :show-trace="showActivities"
        :trace-default-open="activitiesDefaultOpen"
        :trace-duration-ms="traceSummary.durationMs"
        @send="send"
        @cancel="cancel"
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
import { computed, ref } from 'vue'
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

