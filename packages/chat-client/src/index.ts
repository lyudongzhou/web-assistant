// @webassistant/chat-client
// 对话 + 渲染客户端，可被宿主项目 import 内嵌到某个路由。
import { createApp, type App, type Plugin } from 'vue'
import WebAssistant from './WebAssistant.vue'
import WelcomePage from './components/WelcomePage.vue'
import HostAssistantDock from './components/HostAssistantDock.vue'
import HostAssistantChat from './components/HostAssistantChat.vue'
import HostAssistantActivities from './components/HostAssistantActivities.vue'
import TraceTimeline from './components/TraceTimeline.vue'
import MarkdownText from './components/MarkdownText.vue'
import PanelSection from './components/PanelSection.vue'
import PlanCardView from './components/PlanCard.vue'
import AskCardView from './components/AskCard.vue'
import ModeSwitch from './components/ModeSwitch.vue'
import type { WebAssistantProps } from './types.js'

export { WebAssistant }
export { WelcomePage }
// 宿主直连（用法 B）开箱即用的组件：
//   HostAssistantDock        悬浮窗（接线 + 壳 + 对话 + 状态行 + 过程区）—— 第三方首选
//   HostAssistantChat        对话区（数据进 / 事件出，可塞进宿主自己的布局）
//   TraceTimeline            过程区（agent 步骤 + 思考 + runtime 活动合并去重）
//   HostAssistantActivities  纯 runtime 活动折叠条（带「清空」）
//   MarkdownText             结果气泡的 Markdown 渲染（只吃 text，不认 socket / runtime）
//   PlanCard / AskCard / ModeSwitch  回合边界的交互件（计划确认 / 澄清提问 / 模式切换），
//                                    自写 UI 可单独复用（状态迁移规则在 lib/turnState.ts）
export { HostAssistantDock, HostAssistantChat, HostAssistantActivities, TraceTimeline }
export { PlanCardView, AskCardView, ModeSwitch }
// 结果气泡的 Markdown 渲染（数据进、无事件）：自写气泡时用它就能与内置两条渲染面同一份口径
// （安全约束与「宽松解析 + breaks」的取舍都在 lib/markdown.ts 里）
export { MarkdownText }
export { getMarkdownRenderer, renderMarkdown } from './lib/markdown.js'
// 可折叠面板（过程区与计划卡共用的壳：分隔线 / 折叠头 / 状态行 / footer 槽）——
// 自写 panel 时用它就能和内置的两处保持同一套样式与收缩行为（状态配 usePanelOpen）
export { PanelSection }
// 显式上报通道：宿主只装 chat-client（用法 A / 容器模式）时也有明确入口，
// 不必为了 import apiBus 额外引入 @webassistant/wc-runtime-vue。
// 与 wc-runtime-vue / wc-runtime-core 转出的是**同一个全局单例**（Symbol.for + globalThis）。
export { apiBus, type ApiReport } from '@webassistant/wc-runtime-core'
export { useWebAssistant } from './composables/useWebAssistant.js'
export { useRuntimeHost } from './composables/useRuntimeHost.js'
export { useAgentChat } from './composables/useAgentChat.js'
export { useWelcomePage } from './composables/useWelcomePage.js'
// 面板折叠（过程区与计划卡共用的同一份收缩逻辑）：默认值 + 可选 resetKey（内容身份变化即回到默认）
export { usePanelOpen, type PanelOpen } from './composables/usePanelOpen.js'
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
// 回合边界状态的纯逻辑（模式条 / 计划卡 / 问题卡的迁移规则）：自写 UI 可复用同一份口径
export {
  MODE_OPTIONS,
  answerAskCard,
  applyAsk,
  applyMode,
  applyPlan,
  approvePlanCard,
  // 计划修订（「修改计划」）的草稿态迁移 + 本轮结束时收尾
  beginPlanRevision,
  cancelPlanRevision,
  createTurnState,
  describeMode,
  pendingQuestionId,
  settlePlanRevision,
  submitPlanRevision,
  updatePlanDraft,
  visibleAskCard,
  visiblePlanCard,
  type AskCard,
  type PlanCard,
  type PlanCardStatus,
  type TurnState,
} from './lib/turnState.js'
// 计划里的人工步骤（`add-plan-manual-steps`）：等你操作的那一步 + 步骤展示口径 + "刚点完等校验"的反馈态
export {
  beginStepCompletion,
  describeStepStatus,
  handoffStep,
  settleStepCompletion,
  type PlanStepDisplay,
  type PlanStepTone,
} from './lib/turnState.js'
// 渲染面归一化：`surface` 与 `createRuntime` 只推导一次（headless 宿主可用同一份逻辑，避免自己再判一遍）
export { resolveSurfaceKind } from './lib/surface.js'
// 「本轮动作」的格式化/截断纯逻辑：自写 UI 想复用同一套展示口径时用它
export {
  ACTIVITY_DETAIL_CLIP,
  ACTIVITY_VISIBLE_LIMIT,
  activityKey,
  formatActivityDetail,
  formatActivityTime,
  selectVisibleActivities,
} from './lib/activities.js'
// 过程 / 结果分流的纯逻辑：自写 UI 想复用同一套「什么算过程、什么算结果」口径时用它
export {
  TRACE_MERGE_WINDOW_MS,
  TRACE_VISIBLE_LIMIT,
  appendStream,
  buildTraceRows,
  formatDuration,
  mergeTimeline,
  pushStep,
  splitMessages,
  summarizeTrace,
} from './lib/chatTrace.js'

export type {
  ChatMessage,
  ChatMessageKind,
  ChatRole,
  HostAssistantDockProps,
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
export type { ChatSendOptions } from './lib/agentSocket.js'
export type { TraceRow, TimelineItem, TraceSummary, StreamChannel } from './lib/chatTrace.js'
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

/** 命令式挂载：mountWebAssistant('#app', { wcBase, wsBase, services, … }, { plugins }) */
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
