<template>
  <!-- 模式切换：自动（服务端+模型判）/ 直接执行 / 先出计划。
       模式随 `chat.send` 下发；右侧小字是服务端回给的**实际生效模式与判定来源**
       （用户能一眼看出"这次为什么出计划/为什么直接干"）。 -->
  <div class="mode-switch">
    <div class="tabs">
      <button
        v-for="option in MODE_OPTIONS"
        :key="option.value"
        class="tab"
        :class="{ active: option.value === localMode }"
        type="button"
        :title="option.hint"
        @click="select(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
    <span v-if="effectiveText" class="effective">{{ effectiveText }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentMode } from '@webassistant/protocol'
import type { ChatModeMessage } from '@webassistant/protocol/websocket'
import { describeMode, MODE_OPTIONS } from '../lib/turnState.js'

const props = withDefaults(
  defineProps<{
    /** 服务端最近一次下发的模式判定（chat.mode）；null = 还没跑过一轮 */
    mode?: ChatModeMessage | null
  }>(),
  { mode: null },
)

const emit = defineEmits<{
  (e: 'change', mode: AgentMode): void
}>()

const localMode = ref<AgentMode>('auto')

// 服务端回传的 requested 是权威值（可能是服务端按 MODE_DEFAULT 回落的）：
// 用户在别处（例如另一处 UI）改了模式时，这里要跟上；但只在值真的不同时改，避免打断用户点选。
watch(
  () => props.mode?.requested,
  (requested) => {
    if (requested && requested !== localMode.value) localMode.value = requested
  },
)

const effectiveText = computed(() => describeMode(props.mode))

function select(mode: AgentMode): void {
  localMode.value = mode
  emit('change', mode)
}
</script>

<style scoped>
.mode-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 0;
}
.tabs {
  display: inline-flex;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: var(--wa-radius-sm, 6px);
  overflow: hidden;
}
.tab {
  padding: 3px 10px;
  border: 0;
  border-right: 1px solid var(--wa-border, #e5e7eb);
  background: var(--wa-panel-bg, #fff);
  color: var(--wa-text-secondary, #6b7280);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.tab:last-child {
  border-right: 0;
}
.tab.active {
  background: var(--wa-primary-soft, #dbeafe);
  color: var(--wa-primary, #3b82f6);
  font-weight: 600;
}
.effective {
  font-size: 11px;
  color: var(--wa-text-muted, #9ca3af);
}
</style>
