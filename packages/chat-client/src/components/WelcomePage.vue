<template>
  <div class="welcome-page">
    <!-- hero：背景图 + 点阵动效（DotGrid，鼠标视差 / 点击冲击波） -->
    <section class="hero">
      <div class="hero-bg" aria-hidden="true" :style="HERO_BG_STYLE" />
      <DotGrid
        class="hero-dots"
        :dot-size="4"
        :gap="28"
        base-color="#c7d2fe"
        active-color="#6366f1"
        :proximity="170"
      />

      <div class="hero-content">
        <div class="greeting">
          <BlurText
            v-if="headline"
            class-name="greeting-headline"
            :text="headline"
            :delay="80"
            :step-duration="0.5"
          />
        </div>
        <p v-if="heroSub" class="hero-hint">{{ heroSub }}</p>
      </div>
    </section>

    <!-- 能力清单：渐变小标题 + 图片化能力卡片（TiltedCard 3D 倾斜）。
         注意：欢迎语里若含「能力清单式」的列表（agent 默认就会带上），
         这里不再重复渲染 —— 列表内容由卡片承载，见脚本里的 heroSub 注释。 -->
    <section class="capabilities">
      <GradientText
        class="section-title"
        :colors="TITLE_COLORS"
        :animation-speed="6"
        :yoyo="true"
        :pause-on-hover="true"
      >
        我能帮你
      </GradientText>

      <div v-if="capabilities.length" class="card-grid">
        <article v-for="cap in capabilities" :key="cap.tag" class="cap-card">
          <TiltedCard
            :image-src="thumbFor(cap)"
            :alt-text="capTitle(cap)"
            image-height="150px"
            :rotate-amplitude="9"
            :scale-on-hover="1.04"
            :show-mobile-warning="false"
            :show-tooltip="false"
          >
            <div class="cap-title">{{ capTitle(cap) }}</div>
            <div v-if="cap.description" class="cap-desc">{{ cap.description }}</div>
            <div v-if="cap.examples?.length" class="cap-examples">
              例如：{{ cap.examples.join('、') }}
            </div>
          </TiltedCard>
        </article>
      </div>

      <p v-else class="empty-tip">
        {{ loading ? '正在加载能力清单…' : '暂无可操作的页面。' }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
// 内置「欢迎页」：渲染区**空态**（runtime 没有渲染子 WC）时的默认内容。
// 文案/能力清单已由 useWelcomePage 合并好（agent 握手载荷优先，本地 manifest 路由兜底）：
//   text = 欢迎语（缺省用 DEFAULT_WELCOME_TEXT）；capabilities = 能力卡片；loading = 内容是否仍在等数据源。
// 宿主可用 WebAssistant 的 `welcome` prop 或 `#welcome` 插槽整体替换本组件。
//
// 呈现：满屏铺满渲染区 —— hero（背景图 + DotGrid 动效 + BlurText 欢迎语）+ 能力卡片网格
// （TiltedCard 3D 倾斜 + 按 tag 确定性生成的缩略图）。动效组件 vendored 自 Vue Bits，见 ../vuebits/README.md。
import { computed } from 'vue'
import type { WelcomeCapability, WelcomePageProps } from '../types.js'
import { splitWelcomeText } from '../lib/welcome.js'
import { WELCOME_HERO_BG, capabilityThumbnail } from '../assets/welcomeArt.js'
import BlurText from '../vuebits/BlurText.vue'
import GradientText from '../vuebits/GradientText.vue'
import TiltedCard from '../vuebits/TiltedCard.vue'
import DotGrid from '../vuebits/DotGrid.vue'

const props = withDefaults(defineProps<WelcomePageProps>(), {
  text: '',
  capabilities: () => [],
  loading: false,
})

/** 小标题渐变色（与默认品牌蓝协调） */
const TITLE_COLORS = ['#3b82f6', '#8b5cf6', '#22d3ee']

/**
 * hero 背景图样式。
 * 注意 **必须给 url() 加引号**：data URI 里含 `(`/`)`（SVG 的 url(#id) 引用），
 * 不带引号的 `url(...)` 会让整条 background-image 被浏览器丢弃。
 */
const HERO_BG_STYLE = { backgroundImage: `url("${WELCOME_HERO_BG}")` }

/**
 * 欢迎语拆解：只取「列表之前的散文」做 hero 主/副标题，能力清单式列表一律丢弃
 * （列表已由下方卡片承载，且全文会作为 assistant 消息出现在对话里）。
 * 纯逻辑在 lib/welcome.ts 的 `splitWelcomeText`（可单测），这里只做响应式封装。
 */
const heroText = computed(() => splitWelcomeText(props.text))

/** hero 主标题：欢迎语首行 */
const headline = computed(() => heroText.value.headline)

/** hero 副标题：列表之前的散文行（最多 2 行），没有则用内置默认副标题 */
const heroSub = computed(() => heroText.value.subtitle)

function capTitle(cap: WelcomeCapability): string {
  return cap.title || cap.name || cap.tag
}

function thumbFor(cap: WelcomeCapability): string {
  return capabilityThumbnail(cap.tag || capTitle(cap))
}
</script>

<style scoped>
.welcome-page {
  width: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  text-align: left;
  color: var(--wa-text, #1f2937);
}

/* ---- hero：铺满渲染区顶部，背景图 + 点阵动效 ---- */
.hero {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  min-height: 210px;
  /* 高度上限：欢迎语异常长时也不让 hero 撑成超长块（内容在 .hero-content 内可滚动） */
  max-height: min(46vh, 360px);
  padding: 44px 32px;
  overflow: hidden;
}
.hero-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  transform: scale(1.05);
}
.hero .hero-dots {
  position: absolute;
  inset: 0;
  opacity: 0.75;
}
.hero-content {
  position: relative;
  z-index: 1;
  max-width: 720px;
  max-height: 100%;
  overflow-y: auto;
}
.greeting {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.greeting-headline {
  font-size: clamp(20px, 2vw, 30px);
  font-weight: 700;
  line-height: 1.35;
  color: var(--wa-text, #1f2937);
}
.hero-hint {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  color: var(--wa-text-secondary, #6b7280);
}

/* ---- 能力清单 ---- */
.capabilities {
  flex: 1 1 auto;
  padding: 24px 32px 32px;
}
.capabilities .section-title {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 16px;
  align-items: start;
}
.cap-card {
  min-width: 0;
}
.cap-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}
.cap-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wa-text-secondary, #6b7280);
}
.cap-examples {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wa-text-muted, #9ca3af);
}
.empty-tip {
  margin: 24px 0 0;
  font-size: 13px;
  text-align: center;
  color: var(--wa-text-muted, #9ca3af);
}

/* 窄屏（内嵌面板可能很窄）：收紧内边距、缩小列宽 */
@media (max-width: 520px) {
  .hero {
    padding: 32px 20px;
  }
  .capabilities {
    padding: 20px 20px 24px;
  }
  .card-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px;
  }
}
</style>
