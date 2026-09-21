// 「过程步骤」的文案（纯函数，零依赖）：工具名 + 实参 → 面向用户的一句话 + 动作目标。
//
// 为什么值得单独一层：这句话是用户唯一能读到的「agent 正在做什么」，而它最容易在调 prompt 时被
// 顺手改坏 —— 比如把 target 去掉，同一轮里两次 render 就显示成两条一模一样的「正在打开页面」，
// 用户完全分不出它在按顺序打开两个页面（多跳流程会看起来像卡住了）。
// 独立成模块便于单测（不拉起 Nest / SDK），与 turnProjection.ts 同款。
import type {
  CallPageMethodToolArgs,
  RenderToolArgs,
  WaitForObservationToolArgs,
} from '@webassistant/protocol/websocket'

/** 一步的展示信息：给用户的一句话 + 动作目标（客户端按 target 与 runtime 活动配对去重） */
export interface ToolStepDescription {
  text: string
  target?: string
}

/** 安全取字符串（未知形状一律 undefined，绝不抛 —— 观测路径不能影响主流程） */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * 工具**开始执行**时的步骤文案。
 *
 * 目标一律用 `<tag>` / `当前页.方法()` 的写法，与仓库既有口径一致
 * （manifest 清单、旧客户端的 `正在调用 <tag>.method()` 都是这个形状）。
 */
export function describeToolStep(tool: string, args?: unknown): ToolStepDescription {
  if (tool === 'render') {
    const tag = str((args as RenderToolArgs | undefined)?.tag)
    return tag ? { text: `正在打开页面 <${tag}>`, target: tag } : { text: '正在打开页面' }
  }
  if (tool === 'call_page_method') {
    const { name, page } = (args ?? {}) as CallPageMethodToolArgs
    const label = str(page) ? `<${str(page)}>` : '当前页'
    const method = str(name)
    return method
      ? { text: `正在调用 ${label}.${method}()`, target: method }
      : { text: `正在调用 ${label}的方法` }
  }
  if (tool === 'wait_for_observation') {
    const page = str((args as WaitForObservationToolArgs | undefined)?.page)
    return page ? { text: `正在等待页面数据 <${page}>`, target: page } : { text: '正在等待页面数据' }
  }
  // 收尾工具（`lifecycle.completesRun`）：它们不改页面，但会结束本轮 —— 过程区仍要有一行，
  // 否则用户只看到「对话突然结束，多了一张卡片」，无从知道 agent 做了什么。
  if (tool === 'propose_plan') {
    const stepCount = Array.isArray((args as { steps?: unknown[] } | undefined)?.steps)
      ? ((args as { steps: unknown[] }).steps.length)
      : 0
    return stepCount > 0
      ? { text: `正在整理执行计划（${stepCount} 步）`, target: 'plan' }
      : { text: '正在整理执行计划', target: 'plan' }
  }
  if (tool === 'revise_plan') {
    // 修订也是"结束本轮"的动作：过程区要有一行，否则用户只看到卡片内容变了、不知道谁改的
    return { text: '正在按你的意见更新计划', target: 'plan' }
  }
  if (tool === 'ask_user') {
    return { text: '正在向你提问', target: 'ask' }
  }
  if (tool === 'finish_turn') {
    return { text: '正在交接本轮进度', target: 'turn' }
  }
  return { text: `正在执行 ${tool}` }
}

/**
 * 从 `tool-finished` 的 message 里取失败原因（成功返回 undefined）。
 *
 * SDK 的结算消息里工具结果是一个 `tool-result` 部件（`@cline/shared` 的 `AgentToolResultPart`），
 * 成败由 `isError` 表示、`output` 是载荷。这里只做结构化读取，不 import SDK 内部类型
 * （与 turnProjection 的 ProjectablePart 同款做法：只建模我们真正要用的字段）。
 */
export function toolResultError(message: unknown): string | undefined {
  const parts = (message as { parts?: unknown } | undefined)?.parts
  if (!Array.isArray(parts)) return undefined
  for (const raw of parts) {
    const part = raw as { type?: string; isError?: boolean; output?: unknown } | undefined
    if (part?.type !== 'tool-result') continue
    if (!part.isError) return undefined
    if (typeof part.output === 'string' && part.output) return part.output
    if (part.output instanceof Error) return part.output.message
    return '工具执行失败'
  }
  return undefined
}
