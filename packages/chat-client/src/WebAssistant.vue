<template>
  <div class="app">
    <header v-if="title" class="app-header">
      <div>
        <h1>{{ title }}</h1>
        <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
      </div>
      <span v-if="pageTitle" class="current-page">当前页面：{{ pageTitle }}</span>
    </header>

    <!-- host 模式（宿主直连）：**没有渲染区** —— 页面在宿主自己的 <router-view> 渲染。
         这里用一条**紧凑提示条**而不是一整列空面板：host 模式的主要场景是宿主右下角 dock（窄容器），
         整列空面板会把对话区挤到 ~120px（demo 里实测）。提示条保留：模式徽标 + 说明 + 加载/打断，
         错误横幅紧随其后；当前页指示仍由 header 右侧承担（宿主关掉 header 时提示条里补一份，见下）。 -->
    <template v-if="!renderArea">
      <div class="host-hint">
        <span class="host-hint-title">宿主直连模式</span>
        <span class="host-hint-text">
          <!-- 当前页指示优先由 header 右侧那份承担（`title` 非空即有 header）；
               只有宿主关掉 header 时才在提示条里补一份 —— 否则同一句话会在 42px 内出现两遍。 -->
          <template v-if="!pageTitle">页面在宿主界面中打开 · 等待 agent 打开页面…</template>
          <template v-else-if="title">页面在宿主界面中打开（不在本面板渲染）</template>
          <template v-else>页面在宿主界面中打开 · 当前页面：{{ pageTitle }}</template>
        </span>
        <span v-if="status === 'loading'" class="host-hint-tip">加载中…</span>
        <!-- 「思考中」的过程提示由对话区的「过程区」承担（那里面有步骤与耗时），
             这里只留「打断」这个控制 —— 两处都写一句"思考中"是重复提示。 -->
        <button v-if="loading" class="back-btn" @click="cancel()">✕ 打断</button>
      </div>
      <p v-if="error" class="host-error">{{ error.message }}</p>
    </template>

    <div class="main">
      <ChatPanel
        class="panel"
        :messages="messages"
        :loading="loading"
        :placeholder="placeholder"
        :activities="activities"
        :trace-duration-ms="traceSummary.durationMs"
        :plan="plan"
        :ask="ask"
        :mode="mode"
        @send="onSend"
        @new-session="startNewSession"
        @approve-plan="confirmPlan"
        @revision-open="onRevisionOpen"
        @revision-input="updatePlanDraft"
        @revision-cancel="cancelPlanRevision"
        @revise="onRevise"
        @replan="onReplan"
        @step-done="onStepDone"
        @answer="onAnswer"
        @change-mode="onModeChange"
      />

      <div v-if="renderArea" class="render-area panel">
        <div class="panel-title render-title">
          <span>渲染区域</span>
          <span v-if="status === 'loading'" class="loading-tip">加载中…</span>
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
import { computed, ref, watch, type Component } from 'vue'
import type { AgentMode } from '@webassistant/protocol'
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
  sendWith,
  confirmPlan,
  completeStep,
  beginPlanRevision,
  updatePlanDraft,
  cancelPlanRevision,
  revisePlan,
  replan,
  mode,
  plan,
  ask,
  cancel,
  startNewSession,
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
  traceSummary,
  back,
  // 推导后的渲染面（lib/surface.ts）：`renderArea` 用它，**不要**再判 `props.surface` ——
  // 两处各判一次会漂移出静默错配（runtime 实际是 host，面板却渲染一整列空的「渲染区域」）。
  surface: effectiveSurface,
} = useWebAssistant({
  wcBase: props.wcBase,
  wsBase: props.wsBase,
  surface: props.surface,
  createRuntime: props.createRuntime,
  initialPage: props.initialPage,
  services: props.services,
  debug: props.debug,
  onPageChange: (info) => emit('page-change', info),
  onPageEvent: (payload) => emit('page-event', payload),
  onError: (info) => emit('error', info),
  onRuntimeReady: (runtime) => props.onRuntimeReady?.(runtime),
})

/** 是否渲染面板内的「渲染区域」：宿主直连（host）没有它 —— 页面在宿主自己的位置渲染 */
const renderArea = computed(() => effectiveSurface !== 'host')

// ── 回合边界（模式 / 计划 / 提问）的接线 ───────────────────────────────────
// 与 <HostAssistantDock> 同一套语义（卡片 UI 状态在 useAgentChat / lib/turnState.ts，这里只做转译）。

/** 用户选的模式 —— 只在下一轮随 chat.send 下发 */
const selectedMode = ref<AgentMode>('auto')

// 服务端回传的 requested 是权威值（可能被 MODE_DEFAULT 回落）：跟上它，避免"以为已经同步"而不带 mode
watch(
  () => mode.value?.requested,
  (requested) => {
    if (requested) selectedMode.value = requested
  },
)

function onSend(text: string): void {
  const current = mode.value?.requested ?? 'auto'
  if (selectedMode.value !== current) sendWith(text, { mode: selectedMode.value })
  else send(text)
}

function onModeChange(next: AgentMode): void {
  selectedMode.value = next
}

/** 计划卡「修改计划」：展开卡内输入框（草稿态在 `lib/turnState.ts`） */
function onRevisionOpen(): void {
  const card = plan.value
  if (card) beginPlanRevision(card.message.planId)
}

/**
 * 计划卡「提交修改」：带 `revisePlanId` 发出用户的修改意见 —— 服务端把本轮标成修订轮，
 * 模型用 `revise_plan` 在**当前计划**上增量合并（未改动的步骤保 id、保完成状态，planId 不变）。
 * 这与旧的「重新规划」（发一句固定文案、由模型全量重出）是两条不同的路径。
 */
function onRevise(): void {
  const card = plan.value
  if (!card) return
  revisePlan(card.draft ?? '', card)
}

/** 计划卡「重新生成计划」：推倒重来（保留这条路径，用于"换一套方案"） */
function onReplan(): void {
  replan()
}

/**
 * 计划卡「我已完成 / 我已重做，下一步」（人工步骤）：带 `planId` + `stepDoneId` 的一轮。
 * 服务端把该步骤标 `done` 后起一轮，模型先校验再继续；校验不过会用 handoff_step 带 issue 让用户重做。
 */
function onStepDone(stepId: string): void {
  completeStep(plan.value ?? undefined, stepId)
}

function onAnswer(text: string, questionId: string): void {
  sendWith(text, { questionId })
}

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
/* host 模式（无渲染区）的紧凑提示条：一条横条，别再占一整列 ——
   面板落在窄容器（右下角 dock）时，整列空面板会把对话区挤到没法看。 */
.host-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.6;
  background: var(--wa-panel-bg, #fff);
  border-bottom: 1px solid var(--wa-border, #e5e7eb);
}
.host-hint-title {
  padding: 2px 8px;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: 999px;
  background: var(--wa-bg, #f9fafb);
  color: var(--wa-primary, #3b82f6);
  font-weight: 600;
  white-space: nowrap;
}
.host-hint-text {
  min-width: 0;
  color: var(--wa-text-secondary, #6b7280);
}
.host-hint-tip {
  margin-left: auto;
  color: var(--wa-text-muted, #9ca3af);
}
/* 错误横幅：host 模式没有渲染区可承载 `.error-tip`，这里贴一条同色系的横条（不丢错误可见性） */
.host-error {
  margin: 0;
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
  background: var(--wa-error-bg, #fef2f2);
  color: var(--wa-error-text, #b91c1c);
  border-bottom: 1px solid var(--wa-error-border, #fecaca);
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
