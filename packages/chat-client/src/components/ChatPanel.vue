<template>
  <div class="chat-panel">
    <div class="panel-title">
      <span>对话窗口</span>
      <!-- 会话 = 连接：新会话 = 断开重连（服务端新建会话），不必刷新页面 -->
      <button class="new-session" type="button" :disabled="loading" @click="emit('new-session')">
        新会话
      </button>
    </div>

    <div ref="messagesEl" class="messages">
      <div v-if="!messages.length" class="welcome">
        <p>👋 你好，我是页面助手</p>
        <p class="hint">描述你想打开的页面，例如：<br />「我想看用户列表」「打开数据看板」</p>
      </div>

      <!-- 结果气泡：只渲染结果（`kind` 缺省 / `'message'`）。
           正文按 Markdown 渲染（与宿主直连面同一口径，见 <MarkdownText> / lib/markdown.ts）；
           用户自己的话保持纯文本。 -->
      <div v-for="(m, i) in bubbles" :key="i" class="message" :class="m.role">
        <div class="bubble" :class="{ md: isMarkdown(m) }">
          <MarkdownText v-if="isMarkdown(m)" :text="m.content" />
          <template v-else>{{ m.content }}</template>
        </div>
      </div>
    </div>

    <!-- 过程区（步骤 / 思考 / 错误）——与结果气泡分离，流式指示器也在里面。
         容器面与宿主直连面用**同一个**组件与同一份分流口径（见 lib/chatTrace.ts），避免两条渲染面漂移。 -->
    <TraceTimeline
      v-if="showTrace"
      :items="trace"
      :activities="activities"
      :duration-ms="traceDurationMs"
      :loading="loading"
    />

    <!-- 回合边界的交互卡（计划 / 提问）与模式切换：容器面与宿主直连面共用同一批组件，
         避免两条渲染面漂移（同 lib/chatTrace.ts 的做法）。 -->
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

    <form class="input-bar" @submit.prevent="submit">
      <input
        v-model="text"
        class="input"
        :placeholder="placeholder"
        :disabled="loading"
      />
      <button type="submit" class="send" :disabled="!text.trim() || loading">发送</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, computed, watch, useTemplateRef } from 'vue'
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
    /** **全部**消息（结果 + 过程条目）；分流在组件内完成，`kind` 缺省算结果气泡 */
    messages?: ChatMessage[]
    loading?: boolean
    placeholder?: string
    /**
     * 是否用 Markdown 渲染 assistant 的结果气泡（缺省 `true`）。
     * 与宿主直连面（`HostAssistantChat`）同一口径：只作用于**结果气泡**，
     * 用户自己的话 / 过程区 / 计划卡 / 问题卡一律纯文本。
     */
    markdown?: boolean
    /** 是否渲染「过程区」，缺省渲染 */
    showTrace?: boolean
    /** 过程区里本轮耗时（`chat.done.durationMs`） */
    traceDurationMs?: number
    /** runtime 活动（最新在前）——与 agent 步骤合并去重 */
    activities?: WcActivity[]
    /** 当前计划卡（`chat.plan`） */
    plan?: PlanCard | null
    /** 当前问题卡（`chat.ask`） */
    ask?: AskCard | null
    /** 最近一次模式判定（`chat.mode`） */
    mode?: ChatModeMessage | null
    /** 是否渲染模式切换（缺省渲染） */
    showModeSwitch?: boolean
  }>(),
  {
    messages: () => [],
    loading: false,
    placeholder: '描述你想打开的页面…',
    markdown: true,
    showTrace: true,
    traceDurationMs: undefined,
    activities: () => [],
    plan: null,
    ask: null,
    mode: null,
    showModeSwitch: true,
  },
)

/** 过程 / 结果分流（与宿主直连面共用 lib/chatTrace.ts 的同一份规则） */
const split = computed(() => splitMessages(props.messages))
const bubbles = computed(() => split.value.bubbles)
const trace = computed(() => split.value.trace)

/** 这条气泡走不走 Markdown（只认 assistant 的结果气泡；口径与宿主直连面一致） */
function isMarkdown(m: ChatMessage): boolean {
  return props.markdown && m.role === 'assistant'
}

const emit = defineEmits<{
  (event: 'send', text: string): void
  (event: 'new-session'): void
  /** 计划卡「开始执行」 */
  (event: 'approve-plan', plan: PlanCard): void
  /** 计划卡「修改计划」：展开输入的三个事件（草稿态迁移在宿主的 turnState 上） */
  (event: 'revision-open'): void
  (event: 'revision-input', draft: string): void
  (event: 'revision-cancel'): void
  /** 提交修改意见（宿主转成 `revisePlan(draft, plan)`，即 chat.send 带 revisePlanId） */
  (event: 'revise'): void
  /** 计划卡「重新生成计划」（推倒重来） */
  (event: 'replan'): void
  /** 计划卡「我已完成，下一步」（人工步骤）：宿主转成 `completeStep(plan, stepId)` */
  (event: 'step-done', stepId: string): void
  /** 问题卡选项被点 */
  (event: 'answer', text: string, questionId: string): void
  /** 模式切换 */
  (event: 'change-mode', mode: AgentMode): void
}>()

function onAnswer(text: string, questionId: string): void {
  emit('answer', text, questionId)
}

const text = ref('')
const messagesEl = useTemplateRef<HTMLElement>('messagesEl')

function submit(): void {
  const value = text.value.trim()
  if (!value || props.loading) return
  emit('send', value)
  text.value = ''
}

// 新消息时滚到底部
watch(
  () => props.messages.length,
  async () => {
    await nextTick()
    const el = messagesEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--wa-panel-bg, #fff);
}
.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  border-bottom: 1px solid var(--wa-border-light, #f3f4f6);
}
.new-session {
  font: inherit;
  font-weight: 500;
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--wa-border-light, #e5e7eb);
  border-radius: var(--wa-radius-sm, 6px);
  background: transparent;
  color: var(--wa-text-secondary, #6b7280);
  cursor: pointer;
}
.new-session:hover:not(:disabled) {
  color: var(--wa-primary, #3b82f6);
  border-color: var(--wa-primary, #3b82f6);
}
.new-session:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.welcome {
  text-align: center;
  color: var(--wa-text-secondary, #6b7280);
  margin-top: 40px;
}
.welcome .hint {
  font-size: 13px;
  color: var(--wa-text-muted, #9ca3af);
  line-height: 1.6;
}
.message {
  display: flex;
}
.message.user {
  justify-content: flex-end;
}
.message.assistant {
  justify-content: flex-start;
}
.bubble {
  max-width: 85%;
  padding: 10px 14px;
  border-radius: var(--wa-radius-lg, 12px);
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
/* Markdown 气泡：块级元素自己排版（`pre-wrap` 会把换行变成硬换行、把列表与代码块揉烂）。
   单换行的观感由渲染层的 `breaks: true` 保住（见 lib/markdown.ts）。 */
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
  color: var(--wa-text, #1f2937);
  border-bottom-left-radius: 4px;
}
/* 过程区 / 计划卡都固定在消息区与输入栏之间，不参与消息区的滚动 ——
   `flex: 0 0 auto` 现在由共用壳（`PanelSection` 的 `.panel`）统一给，两条渲染面不再各写一份。 */
.input-bar {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--wa-border-light, #f3f4f6);
}
.input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--wa-border-strong, #d1d5db);
  border-radius: var(--wa-radius, 8px);
  font-size: 14px;
  outline: none;
}
.input:focus {
  border-color: var(--wa-primary, #3b82f6);
}
.send {
  padding: 0 20px;
  border: none;
  border-radius: var(--wa-radius, 8px);
  background: var(--wa-primary, #3b82f6);
  color: var(--wa-primary-contrast, #fff);
  font-size: 14px;
  cursor: pointer;
}
.send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
