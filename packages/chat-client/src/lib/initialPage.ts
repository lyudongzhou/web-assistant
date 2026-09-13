// 首屏页面选项的归一化：`initialPage`（宿主 API）→ runtime 的 `initial`。
// 拆成独立无依赖模块，便于单测（不拉起 vue / runtime）。
//
// 背景：runtime.init 默认会「自动打开 manifest 第一个页面」；chat-client 默认改为不打开，
// 让渲染区先展示「欢迎页」（由用户对话或 agent 决定打开哪个页面）。

/** runtime 的 initial 取值：undefined = 用 runtime 默认（第一个页面） */
export type InitialTarget = { tag: string } | null | undefined

export function resolveInitialTarget(initialPage?: boolean | string): InitialTarget {
  if (initialPage === true) return undefined
  if (typeof initialPage === 'string' && initialPage) return { tag: initialPage }
  return null
}
