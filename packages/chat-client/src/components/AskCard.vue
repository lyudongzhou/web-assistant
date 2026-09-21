<template>
  <!-- 问题卡：agent 用 ask_user 收尾时出现（信息不足、需要用户给一个确定性输入）。
       点选项即回答（chat.send 带 questionId）；也可以直接在输入框里打字 —— 两条路等价。 -->
  <div class="ask-card" :class="{ answered }">
    <div class="question">
      <span class="badge">{{ answered ? '已回答' : '需要你确认' }}</span>
      {{ ask.message.question }}
    </div>
    <div v-if="!answered" class="options">
      <button
        v-for="option in ask.message.options"
        :key="option"
        class="option"
        type="button"
        :disabled="disabled"
        @click="emit('answer', option, ask.message.questionId)"
      >
        {{ option }}
      </button>
    </div>
    <p v-else class="foot">你回答：{{ ask.answer }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AskCard } from '../lib/turnState.js'

const props = withDefaults(
  defineProps<{
    ask: AskCard
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{
  (e: 'answer', text: string, questionId: string): void
}>()

const answered = computed(() => props.ask.answer !== undefined)
</script>

<style scoped>
.ask-card {
  margin: 0 12px 8px;
  padding: 10px 12px;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-left: 3px solid var(--wa-warn, #f59e0b);
  border-radius: var(--wa-radius, 8px);
  background: var(--wa-assistant-bubble-bg, #fffbeb);
  font-size: 13px;
  line-height: 1.7;
}
.ask-card.answered {
  border-left-color: var(--wa-text-muted, #9ca3af);
  opacity: 0.92;
}
.question {
  font-weight: 600;
  color: var(--wa-text-strong, #374151);
}
.badge {
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--wa-warn-soft, #fef3c7);
  color: #b45309;
  font-size: 11px;
  font-weight: 500;
}
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.option {
  padding: 4px 10px;
  border: 1px dashed var(--wa-border-strong, #d1d5db);
  border-radius: var(--wa-radius-sm, 6px);
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text-strong, #374151);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.option:hover:not(:disabled) {
  border-style: solid;
  border-color: var(--wa-primary, #3b82f6);
  color: var(--wa-primary, #3b82f6);
}
.option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.foot {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--wa-text-muted, #6b7280);
}
</style>
