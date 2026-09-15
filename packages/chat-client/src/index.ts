// @webassistant/chat-client
// 对话 + 渲染客户端，可被宿主项目 import 内嵌到某个路由。
import { createApp, type App, type Plugin } from 'vue'
import WebAssistant from './WebAssistant.vue'
import WelcomePage from './components/WelcomePage.vue'
import type { WebAssistantProps } from './types.js'

export { WebAssistant }
export { WelcomePage }
export { useWebAssistant } from './composables/useWebAssistant.js'
export { useRuntimeHost } from './composables/useRuntimeHost.js'
export { useAgentChat } from './composables/useAgentChat.js'
export { useWelcomePage } from './composables/useWelcomePage.js'
export { createAgentSocket, type AgentSocket, type AgentSocketOptions, type AgentSocketState } from './lib/agentSocket.js'
// 欢迎页（渲染区空态）的纯逻辑：宿主可复用做自定义渲染 / 单测
export {
  DEFAULT_HERO_SUBTITLE,
  DEFAULT_WELCOME_TEXT,
  resolveWelcomeCapabilities,
  resolveWelcomeComponent,
  resolveWelcomeLoading,
  resolveWelcomeText,
  resolveWelcomeVariant,
  splitWelcomeText,
  type WelcomeHeroText,
  type WelcomeRouteLike,
} from './lib/welcome.js'
export { resolveInitialTarget, type InitialTarget } from './lib/initialPage.js'

export type {
  ChatMessage,
  ChatRole,
  PageChangeInfo,
  PageEventPayload,
  RuntimeErrorInfo,
  RuntimeRoute,
  RuntimeServices,
  RuntimeStatus,
  WebAssistantProps,
  WebAssistantRuntimeContext,
  WebAssistantThemeVars,
  WelcomeCapability,
  WelcomeOverride,
  WelcomePageProps,
  WelcomePageSlotProps,
  WelcomePayload,
  WelcomeVariant,
} from './types.js'
export type { UseRuntimeHostOptions, UseRuntimeHostReturn } from './composables/useRuntimeHost.js'
export type { UseAgentChatOptions, UseAgentChatReturn } from './composables/useAgentChat.js'
export type { UseWelcomePageOptions, UseWelcomePageReturn } from './composables/useWelcomePage.js'
export type { UseWebAssistantOptions, UseWebAssistantReturn } from './composables/useWebAssistant.js'

export interface MountedWebAssistant {
  app: App<Element>
  unmount: () => void
}

export interface MountWebAssistantOptions {
  /**
   * 挂载**之前** `app.use` 的插件 —— 宿主自己的 pinia / i18n / 全局指令等。
   * 用 `<WebAssistant>` 组件内嵌时，宿主 app 自己的插件天然可用；命令式挂载这一档需要显式传。
   */
  plugins?: Plugin[]
}

/** 命令式挂载：mountWebAssistant('#app', { wcBase, agentBase, services, … }, { plugins }) */
export function mountWebAssistant(
  container: string | Element,
  props: WebAssistantProps = {},
  options: MountWebAssistantOptions = {},
): MountedWebAssistant {
  const app = createApp(WebAssistant, props as Record<string, unknown>)
  for (const plugin of options.plugins ?? []) app.use(plugin)
  app.mount(container as string)
  return { app, unmount: () => app.unmount() }
}
