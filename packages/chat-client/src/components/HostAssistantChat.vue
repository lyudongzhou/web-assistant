<template>
  <!-- 对话区（宿主直连面专用）：**数据进来、事件出去** —— 不认识 socket / runtime / manifest。
       可以单独复用（塞进宿主自己的布局 / 用宿主的样子重画），也可以被 <HostAssistantDock> 包成悬浮窗。
       内部按 `ChatMessage.kind` 分两栏：结果气泡（只有答复）+ 过程区（步骤 / 思考 / 错误，
       见 <TraceTimeline>）—— 过程不再以 `> …` 混进结果内容里（那样 UI 无从分离）。 -->
  <div class="chat">
    <div ref="scrollEl" class="messages" @scroll="onScroll">
      <div v-if="!messages.length" class="hello">
        <slot name="empty">
          <p class="hello-title">{{ helloTitle }}</p>
          <p class="hello-hint">{{ helloHint }}</p>
          <div v-if="suggestions.length" class="suggests">
            <button
              v-for="suggestion in suggestions"
              :key="suggestion"
              class="suggest"
              type="button"
              @click="emit('send', suggestion)"
            >
              {{ suggestion }}
            </button>
          </div>
        </slot>
      </div>

      <!-- 结果气泡：只渲染结果（`kind` 缺省 / `'message'`），过程行不再混进来。
           正文按 Markdown 渲染（见 <MarkdownText>）：模型的答复事实上就是 Markdown，
           以前一律 pre-wrap ⇒ 用户看到字面的 `**加粗**` 与 `- 列表`。
           用户自己的话保持纯文本（那是他的原话；而且蓝底气泡上 md 的配色会打架）。 -->
      <div v-for="(message, index) in bubbles" :key="index" class="message" :class="message.role">
        <div class="bubble" :class="{ md: isMarkdown(message) }">
          <MarkdownText v-if="isMarkdown(message)" :text="message.content" />
          <template v-else>{{ message.content }}</template>
        </div>
      </div>
    </div>

    <!-- 过程区（步骤 / 思考 / 错误）：与结果气泡**分离**。
         流式期间的活动指示器也在里面 —— 不再另开一个「思考中…」气泡（那是重复提示）。 -->
    <TraceTimeline
      v-if="showTrace"
      :items="trace"
      :activities="activities"
      :include-activities="includeActivities"
      :default-open="traceDefaultOpen"
      :duration-ms="traceDurationMs"
      :loading="loading"
    />

    <!-- 回合边界的交互卡（计划 / 提问）：固定在过程区与输入栏之间，不随消息区滚动 -->
    <PlanCardView
      v-if="plan"
      :plan="plan"
      :disabled="loading"
      @approve="emit('approve-plan', $event)"
      @open-revision="emit('revision-open')"
      @revision-input="emit('revision-input', $event)"
      @cancel-revision="emit('revision-cancel')"
      @revise="emit('revise')"
      @replan="emit('replan')"
      @step-done="emit('step-done', $event)"
    />
    <AskCardView v-if="ask" :ask="ask" :disabled="loading" @answer="onAnswer" />

    <ModeSwitch v-if="showModeSwitch" :mode="mode" @change="emit('change-mode', $event)" />

    <!-- Enter 监听挂在**外层原生 div** 上：键盘事件从内部 textarea 冒泡上来，必然触发 -->
    <div class="input-bar" @keydown="onKeydown">
      <textarea v-model="text" class="input" rows="2" :placeholder="placeholder"></textarea>
      <button v-if="loading" class="action" type="button" @click="emit('cancel')">打断</button>
      <button v-else class="action primary" type="button" :disabled="!text.trim()" @click="submit">
        发送
      </button>
    </div>
    <p class="foot">Enter 发送 · Shift + Enter 换行</p>
  </div>
</template>

<script setup lang="ts">
// 为什么单独一个组件，而不是给容器面的 `ChatPanel` 加几个 prop：
//   ① 没有标题栏 —— 宿主直连的 dock 有自己的头部（连接态 / 返回 / 新会话 / 收起）
//   ② 输入是多行 textarea + Enter/Shift+Enter；流式时按钮变「打断」
//   ③ 空态是**可点的建议**（直接来自宿主自己的业务能力），不是一句写死的提示语
// 保持 `ChatPanel` 原样 ⇒ 容器面（用法 A）的 DOM 与样式零回归。
import { nextTick, computed, ref, useTemplateRef, watch } from 'vue'
import type { AgentMode } from '@webassistant/protocol'
import type { ChatModeMessage } from '@webassistant/protocol/websocket'
import type { ChatMessage, WcActivity } from '../types.js'
import { splitMessages } from '../lib/chatTrace.js'
import type { AskCard, PlanCard } from '../lib/turnState.js'
import TraceTimeline from './TraceTimeline.vue'
import PlanCardView from './PlanCard.vue'
import AskCardView from './AskCard.vue'
import ModeSwitch from './ModeSwitch.vue'
import MarkdownText from './MarkdownText.vue'

const props = withDefaults(
  defineProps<{
    /**
     * **全部**消息（结果气泡 + 过程条目）。过程 / 结果的分流在组件内部完成
     * （`kind` 缺省一律算结果气泡）—— 老宿主只传结果消息时行为与以前完全一致。
     */
    messages?: ChatMessage[]
    loading?: boolean
    placeholder?: string
    /**
     * 是否用 Markdown 渲染 assistant 的结果气泡（缺省 `true`）。
     * 只作用于**结果气泡**：用户自己的话、过程区、计划卡 / 问题卡一律纯文本。
     * 关掉即为「上 md 之前」的行为（`{{ content }}` + `white-space: pre-wrap`）。
     */
    markdown?: boolean
    /** 空态建议（点一下即发送）；`[]` = 不显示建议区 */
    suggestions?: string[]
    /** 空态标题（缺省内置一句通用文案） */
    helloTitle?: string
    /** 空态说明 */
    helloHint?: string
    /** 是否渲染「过程区」（步骤 / 思考 / 错误），缺省渲染 */
    showTrace?: boolean
    /** 过程区初始是否展开（缺省收起） */
    traceDefaultOpen?: boolean
    /** 过程区里本轮耗时（`chat.done.durationMs`），缺省不显示 */
    traceDurationMs?: number
    /** runtime 活动（最新在前）—— 与 agent 步骤合并去重进同一条时间轴 */
    activities?: WcActivity[]
    /** 是否把 runtime 活动并进过程区（缺省 true） */
    includeActivities?: boolean
    /** 当前计划卡（`chat.plan`）；null = 没有待确认/执行中的计划 */
    plan?: PlanCard | null
    /** 当前问题卡（`chat.ask`）；null = 没有待回答的问题 */
    ask?: AskCard | null
    /** 最近一次模式判定（`chat.mode`），供 ModeSwitch 显示生效模式与判定来源 */
    mode?: ChatModeMessage | null
    /** 是否渲染模式切换（缺省渲染） */
    showModeSwitch?: boolean
  }>(),
  {
    messages: () => [],
    loading: false,
    placeholder: '描述你想做什么…',
    markdown: true,
    suggestions: () => [],
    helloTitle: '让助手替你操作这个系统',
    helloHint: '页面在它自己的位置打开；助手只做「打开 / 筛选 / 预填」这类操作，提交永远由你点。',
    showTrace: true,
    traceDefaultOpen: false,
    traceDurationMs: undefined,
    activities: () => [],
    includeActivities: true,
    plan: null,
    ask: null,
    mode: null,
    showModeSwitch: true,
  },
)

const emit = defineEmits<{
  send: [text: string]
  cancel: []
  /** 计划卡「开始执行」：宿主把它转成 `confirmPlan(plan)`（chat.send 带 planId） */
  'approve-plan': [plan: PlanCard]
  /** 计划卡「修改计划」：展开输入的三个事件（宿主转成 turnState 的草稿态迁移） */
  'revision-open': []
  'revision-input': [draft: string]
  'revision-cancel': []
  /** 提交修改意见：宿主把它转成 `revisePlan(plan.draft, plan)`（chat.send 带 revisePlanId） */
  revise: []
  /** 计划卡「重新生成计划」：推倒重来（宿主发一句话让模型重新 propose_plan） */
  replan: []
  /** 计划卡「我已完成，下一步」（人工步骤）：宿主转成 `completeStep(plan, stepId)` */
  'step-done': [stepId: string]
  /** 问题卡选项被点：宿主把它转成一次带 questionId 的发送 */
  answer: [text: string, questionId: string]
  /** 模式切换（宿主把它记下来，下一轮随 send 带上） */
  'change-mode': [mode: AgentMode]
}>()

/** 问题卡选项 → answer 事件（把 questionId 一起带出去，避免宿主再去查卡片） */
function onAnswer(text: string, questionId: string): void {
  emit('answer', text, questionId)
}

/** 过程 / 结果分流（规则在 lib/chatTrace.ts，纯逻辑可单测） */
const split = computed(() => splitMessages(props.messages))
const bubbles = computed(() => split.value.bubbles)
const trace = computed(() => split.value.trace)

/**
 * 这条气泡走不走 Markdown。
 *
 * 只认 **assistant 的结果气泡**：用户的话是他的原话（且蓝底配色下 md 只会更乱），
 * 过程区 / 计划卡 / 问题卡各有自己的排版口径（见 types.ts 的 ChatMessageKind）。
 */
function isMarkdown(message: ChatMessage): boolean {
  return props.markdown && message.role === 'assistant'
}

const text = ref('')
const scrollEl = useTemplateRef<HTMLElement>('scrollEl')
/** 是否「贴着底部」：用户手动上滚看历史时不再强行拉回 */
const pinned = ref(true)

function submit(): void {
  const value = text.value.trim()
  if (!value || props.loading) return
  emit('send', value)
  text.value = ''
  pinned.value = true
}

/** Enter 发送 / Shift+Enter 换行；输入法组合中的 Enter（isComposing）不能当发送 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
}

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

// 跟随滚动：**看最后一条的内容**而不只是条数 —— 流式拼接时条数没变，只判条数会不跟手
watch(
  () => [props.messages.length, props.messages.at(-1)?.content, props.loading] as const,
  async () => {
    if (!pinned.value) return
    await nextTick()
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text, #1f2937);
}
.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hello {
  margin: 18px 4px 4px;
}
.hello-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}
.hello-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wa-text-secondary, #6b7280);
}
.suggests {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 12px;
}
.suggest {
  font: inherit;
  font-size: 12px;
  padding: 6px 10px;
  border: 1px dashed var(--wa-border-strong, #d1d5db);
  border-radius: var(--wa-radius-sm, 6px);
  background: transparent;
  color: var(--wa-text-secondary, #6b7280);
  cursor: pointer;
  text-align: left;
}
.suggest:hover {
  border-style: solid;
  border-color: var(--wa-primary, #3b82f6);
  color: var(--wa-primary, #3b82f6);
}
.message {
  display: flex;
}
.message.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 88%;
  padding: 8px 12px;
  border-radius: var(--wa-radius, 8px);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
/* Markdown 气泡：块级元素要自己排版，`pre-wrap` 会把每个换行都变成硬换行、把列表/代码块揉烂。
   单换行的观感由渲染层的 `breaks: true` 保住（见 lib/markdown.ts），不靠这里。 */
.bubble.md {
  white-space: normal;
}
.message.user .bubble {
  background: var(--wa-primary, #3b82f6);
  color: var(--wa-primary-contrast, #fff);
  border-bottom-right-radius: 4px;
}
.message.assistant .bubble {
  background: var(--wa-assistant-bubble-bg, #f3f4f6);
  border: 1px solid var(--wa-border, #e5e7eb);
  border-bottom-left-radius: 4px;
}
/* 过程区 / 计划卡都固定在消息区与输入栏之间，不参与消息区的滚动 ——
   `flex: 0 0 auto` 现在由共用壳（`PanelSection` 的 `.panel`）统一给，两条渲染面不再各写一份。 */
.input-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px 0;
  border-top: 1px solid var(--wa-border-light, #f3f4f6);
}
.input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--wa-border-strong, #d1d5db);
  border-radius: var(--wa-radius, 8px);
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
  resize: none;
  outline: none;
}
.input:focus {
  border-color: var(--wa-primary, #3b82f6);
}
.action {
  flex: 0 0 auto;
  padding: 8px 14px;
  border: 1px solid var(--wa-border-strong, #d1d5db);
  border-radius: var(--wa-radius, 8px);
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text-strong, #374151);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.action.primary {
  border-color: var(--wa-primary, #3b82f6);
  background: var(--wa-primary, #3b82f6);
  color: var(--wa-primary-contrast, #fff);
}
.action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.foot {
  margin: 0;
  padding: 2px 12px 6px;
  font-size: 11px;
  color: var(--wa-text-muted, #9ca3af);
}
</style>
