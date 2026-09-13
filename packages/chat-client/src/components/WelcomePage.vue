<template>
  <div class="welcome-page">
    <p class="greeting">{{ text || DEFAULT_WELCOME_TEXT }}</p>

    <div v-if="capabilities.length" class="capabilities">
      <div class="section-title">我能帮你</div>
      <ul class="list">
        <li v-for="cap in capabilities" :key="cap.tag" class="item">
          <div class="item-title">{{ cap.title || cap.name || cap.tag }}</div>
          <div v-if="cap.description" class="item-desc">{{ cap.description }}</div>
          <div v-if="cap.examples?.length" class="item-examples">
            例如：{{ cap.examples.join('、') }}
          </div>
        </li>
      </ul>
    </div>

    <p v-else class="empty-tip">
      {{ loading ? '正在加载能力清单…' : '暂无可操作的页面。' }}
    </p>
  </div>
</template>

<script setup lang="ts">
// 内置「欢迎页」：渲染区**空态**（runtime 没有渲染子 WC）时的默认内容。
// 文案/能力清单已由 useWelcomePage 合并好（agent 握手载荷优先，本地 manifest 路由兜底）：
//   text = 欢迎语（缺省用 DEFAULT_WELCOME_TEXT）；capabilities = 能力卡片；loading = 内容是否仍在等数据源。
// 宿主可用 WebAssistant 的 `welcome` prop 或 `#welcome` 插槽整体替换本组件。
import type { WelcomePageProps } from '../types.js'
import { DEFAULT_WELCOME_TEXT } from '../lib/welcome.js'

withDefaults(defineProps<WelcomePageProps>(), {
  text: '',
  capabilities: () => [],
  loading: false,
})
</script>

<style scoped>
.welcome-page {
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  text-align: left;
  color: var(--wa-text, #1f2937);
}
.greeting {
  margin: 0;
  font-size: 15px;
  line-height: 1.8;
  white-space: pre-wrap;
  color: var(--wa-text-secondary, #6b7280);
}
.capabilities {
  margin-top: 20px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wa-text-muted, #9ca3af);
  margin-bottom: 10px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}
.item {
  padding: 12px 14px;
  border: 1px solid var(--wa-border, #e5e7eb);
  border-radius: var(--wa-radius, 8px);
  background: var(--wa-panel-bg, #fff);
}
.item-title {
  font-size: 14px;
  font-weight: 600;
}
.item-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wa-text-secondary, #6b7280);
}
.item-examples {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wa-text-muted, #9ca3af);
}
.empty-tip {
  margin: 20px 0 0;
  font-size: 13px;
  text-align: center;
  color: var(--wa-text-muted, #9ca3af);
}
</style>
