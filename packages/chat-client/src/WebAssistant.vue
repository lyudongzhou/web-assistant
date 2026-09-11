<template>
  <div class="app">
    <header v-if="title" class="app-header">
      <div>
        <h1>{{ title }}</h1>
        <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
      </div>
      <span v-if="pageTitle" class="current-page">当前页面：{{ pageTitle }}</span>
    </header>

    <div class="main">
      <ChatPanel
        class="panel"
        :messages="messages"
        :loading="loading"
        :placeholder="placeholder"
        @send="send"
      />

      <div class="render-area panel">
        <div class="panel-title render-title">
          <span>渲染区域</span>
          <span v-if="status === 'loading'" class="loading-tip">加载中…</span>
          <span v-if="loading" class="loading-tip">Agent 思考中…</span>
          <button v-if="loading" class="back-btn" @click="cancel()">
            ✕ 打断
          </button>
          <button v-if="showBackButton" class="back-btn" :disabled="!canGoBack" @click="back()">
            ← 返回
          </button>
        </div>
        <div class="render-body">
          <div ref="mountEl" class="mount" :class="{ 'has-page': hasPage }"></div>
          <div v-if="!hasPage" class="empty">
            <p v-if="error">{{ error.message }}</p>
            <template v-else>
              <p>暂无页面</p>
              <p class="hint">在左侧对话中描述你想打开的页面<br />页面将在这里渲染</p>
            </template>
          </div>
        </div>
      </div>

      <!-- 执行监视：WC 活动时间线（方法调用 / 导航 / 事件 / 数据上报 / 网络 / 错误） -->
      <ActivityLog
        v-if="showActivityLog"
        class="panel activity-panel"
        :activities="activities"
        @clear="clearActivities"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import ChatPanel from './components/ChatPanel.vue'
import ActivityLog from './components/ActivityLog.vue'
import { useWebAssistant } from './composables/useWebAssistant.js'
import type {
  PageChangeInfo,
  PageEventPayload,
  RuntimeErrorInfo,
  WebAssistantProps,
} from './types.js'

const props = withDefaults(defineProps<WebAssistantProps>(), {
  wcBase: '/wc',
  wsBase: '/ws',
  services: undefined,
  title: 'Web Assistant',
  subtitle: '',
  placeholder: '描述你想打开的页面…',
  showBackButton: true,
  forwardPageEvents: false,
  showActivityLog: false,
  debug: false,
})

const emit = defineEmits<{
  (event: 'page-change', info: PageChangeInfo): void
  (event: 'page-event', payload: PageEventPayload): void
  (event: 'error', error: RuntimeErrorInfo): void
}>()

// 全部核心逻辑（socket / runtime 宿主 / 对话状态机 / 事件转发）已收敛到 useWebAssistant。
// 本组件只保留布局与样式，通过回调把事件透出为原有 emit（向后兼容）。
const {
  messages,
  loading,
  send,
  cancel,
  mountEl,
  pageTitle,
  hasPage,
  canGoBack,
  status,
  error,
  activities,
  clearActivities,
  back,
} = useWebAssistant({
  wcBase: props.wcBase,
  wsBase: props.wsBase,
  services: props.services,
  debug: props.debug,
  onPageChange: (info) => emit('page-change', info),
  onPageEvent: (payload) => emit('page-event', payload),
  onError: (info) => emit('error', info),
})
</script>

<style scoped>
.loading-tip {
  margin-left: auto;
  margin-right: 12px;
  font-size: 12px;
  color: var(--wa-text-muted, #9ca3af);
}
.app,
.app * {
  box-sizing: border-box;
}
.app {
  display: flex;
  flex-direction: column;
  height: var(--wa-height, 100vh);
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--wa-text, #1f2937);
}
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: var(--wa-panel-bg, #fff);
  border-bottom: 1px solid var(--wa-border, #e5e7eb);
}
.app-header h1 {
  margin: 0;
  font-size: 18px;
}
.subtitle {
  font-size: 12px;
  color: var(--wa-text-muted, #9ca3af);
}
.current-page {
  font-size: 13px;
  color: var(--wa-primary, #3b82f6);
  font-weight: 600;
}
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.panel {
  flex: 1;
  min-width: 0;
}
.panel + .panel {
  border-left: 1px solid var(--wa-border, #e5e7eb);
}
/* 执行监视面板：固定宽度（不参与 flex 拉伸） */
.activity-panel {
  flex: 0 0 var(--wa-log-width, 320px);
  min-height: 0;
}
.render-area {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--wa-bg, #f9fafb);
}
.panel-title {
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  border-bottom: 1px solid var(--wa-border, #e5e7eb);
  background: var(--wa-panel-bg, #fff);
}
.render-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.back-btn {
  padding: 4px 12px;
  font-size: 13px;
  border: 1px solid var(--wa-border-strong, #d1d5db);
  border-radius: var(--wa-radius-sm, 6px);
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text-strong, #374151);
  cursor: pointer;
}
.back-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.render-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  position: relative;
}
.mount {
  min-height: 100%;
}
.mount.has-page {
  background: var(--wa-panel-bg, #fff);
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: var(--wa-radius, 8px);
  padding: 16px;
}
.empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--wa-text-muted, #9ca3af);
}
.empty .hint {
  font-size: 13px;
  text-align: center;
  line-height: 1.6;
}
</style>
