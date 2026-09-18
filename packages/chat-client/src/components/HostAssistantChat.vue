<template>
  <!-- 对话区（宿主直连面专用）：**数据进来、事件出去** —— 不认识 socket / runtime / manifest。
       可以单独复用（塞进宿主自己的布局 / 用宿主的样子重画），也可以被 <HostAssistantDock> 包成悬浮窗。 -->
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

      <div v-for="(message, index) in messages" :key="index" class="message" :class="message.role">
        <div class="bubble">{{ message.content }}</div>
      </div>

      <div v-if="loading" class="message assistant">
        <div class="bubble typing">思考中…</div>
      </div>
    </div>

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
import { nextTick, ref, useTemplateRef, watch } from 'vue'
import type { ChatMessage } from '../types.js'

const props = withDefaults(
  defineProps<{
    messages?: ChatMessage[]
    loading?: boolean
    placeholder?: string
    /** 空态建议（点一下即发送）；`[]` = 不显示建议区 */
    suggestions?: string[]
    /** 空态标题（缺省内置一句通用文案） */
    helloTitle?: string
    /** 空态说明 */
    helloHint?: string
  }>(),
  {
    messages: () => [],
    loading: false,
    placeholder: '描述你想做什么…',
    suggestions: () => [],
    helloTitle: '让助手替你操作这个系统',
    helloHint: '页面在它自己的位置打开；助手只做「打开 / 筛选 / 预填」这类操作，提交永远由你点。',
  },
)

const emit = defineEmits<{
  send: [text: string]
  cancel: []
}>()

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
.typing {
  color: var(--wa-text-muted, #9ca3af);
}
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
