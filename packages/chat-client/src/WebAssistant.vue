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
          <!-- 渲染区空态（runtime 没有渲染子 WC）→ 欢迎页。
               覆盖优先级：`#welcome` 插槽 > `welcome` prop > 内置 WelcomePage > `welcome=false` 最小空态。
               错误独立成横幅，不再顶掉欢迎页。 -->
          <div v-if="!hasPage" class="empty">
            <p v-if="error" class="error-tip">{{ error.message }}</p>
            <slot name="welcome" v-bind="welcomeSlotProps">
              <component
                :is="welcomeComponent"
                v-if="welcomeComponent"
                :text="welcomeText"
                :capabilities="welcomeCapabilities"
                :loading="welcomeLoading"
              />
              <template v-else>
                <div class="empty-fallback">
                  <p>暂无页面</p>
                  <p class="hint">在左侧对话中描述你想打开的页面<br />页面将在这里渲染</p>
                </div>
              </template>
            </slot>
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
import { computed, type Component } from 'vue'
import ChatPanel from './components/ChatPanel.vue'
import ActivityLog from './components/ActivityLog.vue'
import WelcomePage from './components/WelcomePage.vue'
import { useWebAssistant } from './composables/useWebAssistant.js'
import { resolveWelcomeComponent } from './lib/welcome.js'
import type {
  PageChangeInfo,
  PageEventPayload,
  RuntimeErrorInfo,
  WebAssistantProps,
  WelcomePageSlotProps,
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
  // ★ 必须显式给默认值：`welcome` 的类型含 Boolean，Vue 会把「缺省」布尔转换为 `false`
  //   （isAbsent && !hasDefault → value = false），那样「不传 welcome」会被误判成「宿主关闭了欢迎页」，
  //   内置 WelcomePage 永远不渲染、只剩最小空态。给了 default 后缺省即 undefined。
  welcome: undefined,
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
  welcome: welcomeData,
  welcomePage,
  send,
  cancel,
  mountEl,
  pageTitle,
  hasPage,
  canGoBack,
  status,
  error,
  routes,
  currentTag,
  activities,
  clearActivities,
  back,
} = useWebAssistant({
  wcBase: props.wcBase,
  wsBase: props.wsBase,
  initialPage: props.initialPage,
  services: props.services,
  debug: props.debug,
  onPageChange: (info) => emit('page-change', info),
  onPageEvent: (payload) => emit('page-event', payload),
  onError: (info) => emit('error', info),
  onRuntimeReady: (runtime) => props.onRuntimeReady?.(runtime),
})

// 欢迎页 = 渲染区空态（runtime 没有渲染子 WC）。状态机在 useWebAssistant 里算好（纯逻辑见 lib/welcome.ts），
// 因此「内置默认」与「宿主自定义」用的是同一份判断/合并。
const {
  variant: welcomeVariant,
  text: welcomeText,
  capabilities: welcomeCapabilities,
  loading: welcomeLoading,
} = welcomePage

// 覆盖组件：`welcome=false` 关闭（回退最小空态）；缺省用内置 WelcomePage。
// `#welcome` 具名插槽优先级最高（见模板；插槽入参是合并后的完整状态）。
// 用 resolveWelcomeComponent 而不是三元表达式：非组件值（含 Vue 布尔转换产生的 true/空串）也回退内置组件。
const welcomeComponent = computed<Component | null>(() =>
  resolveWelcomeComponent<Component>(props.welcome, WelcomePage),
)

// `#welcome` 插槽入参：合并后的欢迎页状态（宿主模板不必自己判空/合并）
const welcomeSlotProps = computed<WelcomePageSlotProps>(() => ({
  welcome: welcomeData.value,
  routes: routes.value,
  currentTag: currentTag.value,
  variant: welcomeVariant.value,
  text: welcomeText.value,
  capabilities: welcomeCapabilities.value,
  loading: welcomeLoading.value,
}))
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
  align-items: stretch;
  justify-content: flex-start;
  padding: 0;
  overflow-y: auto;
  color: var(--wa-text-muted, #9ca3af);
}
/* 最小空态（`welcome=false`）自身的居中容器：欢迎页铺满，这里由它负责居中留白 */
.empty-fallback {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.empty .hint {
  font-size: 13px;
  text-align: center;
  line-height: 1.6;
}
/* 渲染区错误横幅：与欢迎页解耦（不再互相顶掉）。
   注意**仅无页时显示**：有页面时页面加载失败由容器渲染 `.wa-runtime-error`，
   其余运行时错误走 `error` ref / `@error` emit（程序化面）。 */
.error-tip {
  width: 100%;
  max-width: 640px;
  margin: 16px auto 0;
  padding: 10px 14px;
  border: 1px solid var(--wa-error-border, #fecaca);
  border-radius: var(--wa-radius, 8px);
  background: var(--wa-error-bg, #fef2f2);
  color: var(--wa-error-text, #b91c1c);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}
</style>
