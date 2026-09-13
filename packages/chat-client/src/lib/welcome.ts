// 渲染区「欢迎页」的纯逻辑（零依赖，便于单测；与 lib/initialPage.ts 同款）。
//
// 定义（关键）：**欢迎页 = runtime 当前没有页面（没有渲染子 WC）时渲染区的默认内容**。
// 判据是 runtime 的「当前页 tag」：`currentTag === null` ⇔ 渲染区处于空态 ⇔ 显示欢迎页。
// 一旦有页面（子 WC）接管渲染区，欢迎页就该消失；页面加载失败/连接异常不会改变「有没有页面」这个事实，
// 错误另行展示，不顶掉欢迎页。
//
// 分层：本文件只做判断与合并（可单测）；响应式封装见 composables/useWelcomePage.ts；
// 默认呈现组件见 components/WelcomePage.vue（宿主可用 WebAssistant 的 `welcome` prop / `#welcome` 插槽覆盖）。
import type { WelcomeCapability, WelcomePayload } from '@webassistant/protocol'

/** 内置默认问候语：agent 未下发欢迎载荷（旧服务端 / `WELCOME_ENABLED=0` / 未连接）时使用 */
export const DEFAULT_WELCOME_TEXT =
  '你好，我是本站的智能助手 👋 我可以理解你的需求，直接帮你打开并操作对应的页面。\n直接说出你想做什么就可以了。'

/** 渲染区当前应呈现的内容类型 */
export type WelcomeVariant =
  /** 有页面：渲染区由页面（子 WC）接管，不显示欢迎页 */
  | 'page'
  /** 无页 + 欢迎内容仍在等数据源（握手载荷 / 本地 manifest 都没就绪）→ 欢迎页的加载态 */
  | 'welcome-loading'
  /** 无页 + 内容已确定（有内容或明确没有）→ 欢迎页 */
  | 'welcome'

/** 能力清单兜底时只用到这三个字段（结构性类型，避免 lib 依赖 runtime 类型） */
export interface WelcomeRouteLike {
  tag: string
  name?: string
  title?: string
}

/**
 * 渲染区该呈现什么：`currentTag === null`（没有渲染子 WC）时才是欢迎页。
 * `loading` 见 resolveWelcomeLoading；判定顺序保证「有页面」永远压过加载态。
 */
export function resolveWelcomeVariant(input: {
  /** runtime 当前页 tag；null = 没有渲染子 WC */
  currentTag: string | null
  /** 欢迎内容是否仍在等数据源 */
  loading: boolean
}): WelcomeVariant {
  if (input.currentTag !== null) return 'page'
  return input.loading ? 'welcome-loading' : 'welcome'
}

/**
 * 欢迎内容是否仍在等数据源：两个来源（握手载荷 `session.ready.welcome` / 本地 manifest 路由）都还没 settle。
 * 只要有一边 settle（**成功或失败都算**），就退出加载态 —— 否则 manifest 拉取失败时会永远转圈。
 */
export function resolveWelcomeLoading(input: {
  /** 是否已收到 `session.ready`（握手完成：欢迎载荷有无都已确定） */
  sessionReady: boolean
  /** 本地 manifest 是否已 settle（加载成功或失败） */
  manifestSettled: boolean
}): boolean {
  return !input.sessionReady && !input.manifestSettled
}

/**
 * 解析「欢迎页覆盖组件」：
 * - `false` → 关闭（返回 null，回退最小空态）
 * - 合法组件（对象 / 函数）→ 用宿主组件
 * - 缺省 / 其它非法值 → 用 `fallback`（内置 WelcomePage）
 *
 * ⚠️ 配合的坑：Vue 对**类型里含 Boolean** 的 prop 有「缺省即 false」的布尔转换
 * （runtime-core：`if (shouldCast) { if (isAbsent && !hasDefault) value = false }`）。
 * 所以 `WebAssistantProps.welcome` 必须显式给 `default: undefined`（见 WebAssistant.vue 的 withDefaults），
 * 否则「不传 welcome」会被当成 `false`，内置欢迎页永远不渲染（只看到最小空态）。
 * 这里再兜一层：非组件值（含布尔转换产生的 `true` / 空串）一律回退内置组件，而不是把非法值交给 `<component :is>`。
 */
export function resolveWelcomeComponent<T>(override: unknown, fallback: T): T | null {
  if (override === false) return null
  const isComponentLike =
    typeof override === 'function' || (typeof override === 'object' && override !== null)
  return isComponentLike ? (override as T) : fallback
}

/** 欢迎语正文：优先用 agent 下发的，缺省回退内置默认文案 */
export function resolveWelcomeText(
  payload: WelcomePayload | null | undefined,
  fallback: string = DEFAULT_WELCOME_TEXT,
): string {
  const text = payload?.text?.trim()
  return text || fallback
}

/**
 * 能力清单：优先用 agent 在握手时下发的载荷（含 description / examples）；
 * 旧服务端未下发时用本地 manifest 路由兜底（只有 tag / name / title）。
 */
export function resolveWelcomeCapabilities(
  payload: WelcomePayload | null | undefined,
  routes: readonly WelcomeRouteLike[] | null | undefined,
): WelcomeCapability[] {
  const fromServer = payload?.capabilities
  if (fromServer?.length) return fromServer
  return (routes ?? []).map((route) => ({
    tag: route.tag,
    ...(route.name ? { name: route.name } : {}),
    ...(route.title ? { title: route.title } : {}),
  }))
}
