<template>
  <div class="chat-panel">
    <div class="panel-title">对话窗口</div>

    <div ref="messagesEl" class="messages">
      <div v-if="!messages.length" class="welcome">
        <p>👋 你好，我是页面助手</p>
        <p class="hint">描述你想打开的页面，例如：<br />「我想看用户列表」「打开数据看板」</p>
      </div>

      <div v-for="(m, i) in messages" :key="i" class="message" :class="m.role">
        <div class="bubble">{{ m.content }}</div>
      </div>

      <div v-if="loading" class="message assistant">
        <div class="bubble typing">思考中…</div>
      </div>
    </div>

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
import { ref, nextTick, watch, useTemplateRef } from 'vue'
import type { ChatMessage } from '../types.js'

const props = withDefaults(
  defineProps<{
    messages?: ChatMessage[]
    loading?: boolean
    placeholder?: string
  }>(),
  {
    messages: () => [],
    loading: false,
    placeholder: '描述你想打开的页面…',
  },
)

const emit = defineEmits<{ (event: 'send', text: string): void }>()

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
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  border-bottom: 1px solid var(--wa-border-light, #f3f4f6);
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
.typing {
  color: var(--wa-text-muted, #9ca3af);
}
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
