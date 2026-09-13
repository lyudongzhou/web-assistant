// 欢迎页状态机（宿主可直接用）：把「无页判定 + 文案 + 能力清单 + 加载态」收敛成一份 view-model。
//
// - WebAssistant.vue 用它渲染内置欢迎页 —— 保证「内置默认」与「宿主自定义」用的是同一份逻辑；
// - headless 宿主用它 + 导出的 WelcomePage（或自己的组件）自行渲染，不必再抄一遍判断/合并。
//
// 纯逻辑在 lib/welcome.ts（可单测），这里只做响应式封装。
import { computed, type ComputedRef, type Ref } from 'vue'
import type { WelcomeCapability, WelcomePayload } from '@webassistant/protocol'
import {
  resolveWelcomeCapabilities,
  resolveWelcomeLoading,
  resolveWelcomeText,
  resolveWelcomeVariant,
  type WelcomeRouteLike,
  type WelcomeVariant,
} from '../lib/welcome.js'

export interface UseWelcomePageOptions {
  /** agent 握手下发的欢迎载荷（未下发 / 未连接 / WELCOME_ENABLED=0 时为 null） */
  welcome: Ref<WelcomePayload | null>
  /** 本地 manifest 路由（旧服务端兜底能力清单） */
  routes: Ref<readonly WelcomeRouteLike[]>
  /** runtime 当前页 tag；null = 没有渲染子 WC（渲染区空态 → 欢迎页） */
  currentTag: Ref<string | null>
  /** 是否已收到 `session.ready` */
  sessionReady: Ref<boolean>
  /** 本地 manifest 是否已 settle（加载成功或失败） */
  manifestSettled: Ref<boolean>
}

export interface UseWelcomePageReturn {
  /** 渲染区当前应呈现的内容类型：`page` / `welcome-loading` / `welcome` */
  variant: ComputedRef<WelcomeVariant>
  /** 是否显示欢迎页（= 无页）；false 时渲染区由页面（子 WC）接管 */
  visible: ComputedRef<boolean>
  /** 欢迎语正文（已合并兜底） */
  text: ComputedRef<string>
  /** 能力清单（已合并：握手载荷优先，本地 manifest 兜底） */
  capabilities: ComputedRef<WelcomeCapability[]>
  /** 欢迎内容是否仍在等数据源（variant === 'welcome-loading' 时为 true） */
  loading: ComputedRef<boolean>
}

export function useWelcomePage(options: UseWelcomePageOptions): UseWelcomePageReturn {
  const loading = computed(() =>
    resolveWelcomeLoading({
      sessionReady: options.sessionReady.value,
      manifestSettled: options.manifestSettled.value,
    }),
  )

  const variant = computed(() =>
    resolveWelcomeVariant({ currentTag: options.currentTag.value, loading: loading.value }),
  )

  return {
    variant,
    visible: computed(() => variant.value !== 'page'),
    text: computed(() => resolveWelcomeText(options.welcome.value)),
    capabilities: computed(() =>
      resolveWelcomeCapabilities(options.welcome.value, options.routes.value),
    ),
    loading,
  }
}
