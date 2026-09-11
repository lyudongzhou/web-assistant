// @webassistant/chat-client
// 对话 + 渲染客户端，可被宿主项目 import 内嵌到某个路由。
import { createApp, type App } from 'vue'
import WebAssistant from './WebAssistant.vue'
import type { WebAssistantProps } from './types.js'

export { WebAssistant }
export { useWebAssistant } from './composables/useWebAssistant.js'
export { useRuntimeHost } from './composables/useRuntimeHost.js'
export { useAgentChat } from './composables/useAgentChat.js'
export { createAgentSocket, type AgentSocket, type AgentSocketOptions, type AgentSocketState } from './lib/agentSocket.js'

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
  WebAssistantThemeVars,
} from './types.js'
export type { UseRuntimeHostOptions, UseRuntimeHostReturn } from './composables/useRuntimeHost.js'
export type { UseAgentChatOptions, UseAgentChatReturn } from './composables/useAgentChat.js'
export type { UseWebAssistantOptions, UseWebAssistantReturn } from './composables/useWebAssistant.js'

export interface MountedWebAssistant {
  app: App<Element>
  unmount: () => void
}

/** 命令式挂载：mountWebAssistant('#app', { wcBase, agentBase, services, … }) */
export function mountWebAssistant(
  container: string | Element,
  props: WebAssistantProps = {},
): MountedWebAssistant {
  const app = createApp(WebAssistant, props as Record<string, unknown>)
  app.mount(container as string)
  return { app, unmount: () => app.unmount() }
}
