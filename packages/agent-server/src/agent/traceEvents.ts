// SDK 运行时事件 → 推给客户端的消息（纯函数，零依赖）。
//
// 为什么把这层单独拆出来：这里正是「思考的过程与结果分不开」的事故点 ——
//   `assistant-reasoning-delta`（模型真思考）此前**根本没被订阅**，
//   而过程只靠「工具名 → 三条固定中文」拼出来，且与结果正文共用一根流式字符串。
// 抽成纯函数后可以脱离 LLM / Nest / WS 单测（新增一个工具的文案、
// 结算配不上开始、模型不吐 reasoning 等分支都能验），不必依赖真实 API 额度。
import type { AgentStepMessage, ChatTextMessage, ToolName } from '@webassistant/protocol/websocket'
import { describeToolStep, toolResultError } from './traceText.js'

/**
 * 我们真正用到的 SDK 事件字段（不 import SDK 内部类型 —— 与 turnProjection 的
 * `ProjectablePart` 同款做法：只建模要用的部分，既能单测也不怕 SDK 内部改路径）。
 */
export interface TraceEventEnvelope {
  type: string
  iteration?: number
  /** `assistant-text-delta` / `assistant-reasoning-delta` 的增量 */
  text?: string
  /** `tool-started` / `tool-finished` */
  toolCall?: { toolName: string; toolCallId?: string; input?: unknown }
  /** `tool-finished` 的结算消息（parts 里有 tool-result，isError 表示成败） */
  message?: unknown
  /** `run-failed` 的错误分类 */
  errorClass?: string
}

/** 一条要推给客户端的消息（结果正文 / 思考 / 过程步骤） */
export type TraceMessage = ChatTextMessage | AgentStepMessage

export interface TraceProjection {
  /** 要按顺序推给客户端的消息（0 条 = 这个事件不对外可见） */
  messages: TraceMessage[]
  /**
   * 本次增量是否计入「本轮已流式产出的助手文本」（run 结束兜底补发用）。
   * **只有结果通道计入** —— reasoning 不在 `result.outputText` 里，计进去会造成重复补发。
   */
  streamText: boolean
}

/**
 * 把一条 SDK 事件投影成待推送消息。
 *
 * `toolStartedAt` 是**跨事件**的配对表（toolCallId → 开始时间），因为 SDK 的
 * `tool-finished` 不带 `durationMs` —— 耗时只能在这里自己配对算出来。
 * 由调用方持有，`run-started` / 每轮开始时清空（避免 abort 后残留配对算出离谱耗时）。
 */
export function projectTraceEvent(
  event: TraceEventEnvelope,
  toolStartedAt: Map<string, number>,
  now: number = Date.now(),
): TraceProjection {
  const nothing: TraceProjection = { messages: [], streamText: false }

  // 结果正文：用户要的答复
  if (event.type === 'assistant-text-delta' && event.text) {
    return {
      messages: [{ t: 'chat.text', delta: event.text, channel: 'text' }],
      streamText: true,
    }
  }

  // 思考：模型的 reasoning 增量。**独立通道** —— 客户端据此与结果分栏，
  // 「想的」与「答的」不再是同一根字符串。
  // 推理模型才有内容；非推理模型这里静默无输出（客户端拿到空通道即不渲染该区域）。
  if (event.type === 'assistant-reasoning-delta' && event.text) {
    return {
      messages: [{ t: 'chat.text', delta: event.text, channel: 'reasoning' }],
      streamText: false,
    }
  }

  // 过程步骤：开始 —— 文案带上动作目标（否则两次 render 在 UI 上长得一模一样）
  if (event.type === 'tool-started' && event.toolCall) {
    const tool = event.toolCall.toolName
    const described = describeToolStep(tool, event.toolCall.input)
    if (event.toolCall.toolCallId) toolStartedAt.set(event.toolCall.toolCallId, now)
    return {
      messages: [
        {
          t: 'agent.step',
          index: event.iteration || 0,
          phase: 'start',
          text: described.text,
          tool: tool as ToolName,
          ...(described.target ? { target: described.target } : {}),
          ...(event.toolCall.input === undefined ? {} : { args: event.toolCall.input }),
        },
      ],
      streamText: false,
    }
  }

  // 过程步骤：结束 —— 把上面那一行「闭合」（成败 + 耗时）
  if (event.type === 'tool-finished' && event.toolCall) {
    const tool = event.toolCall.toolName
    const id = event.toolCall.toolCallId
    const startedAt = id ? toolStartedAt.get(id) : undefined
    if (id) toolStartedAt.delete(id)
    const error = toolResultError(event.message)
    const durationMs = startedAt === undefined ? undefined : now - startedAt
    const described = describeToolStep(tool, event.toolCall.input)
    return {
      messages: [
        {
          t: 'agent.step',
          index: event.iteration || 0,
          phase: 'end',
          text: described.text,
          tool: tool as ToolName,
          ...(described.target ? { target: described.target } : {}),
          ok: !error,
          ...(error ? { error } : {}),
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      ],
      streamText: false,
    }
  }

  // 其余事件（run-started / turn-started / usage-updated / …）不对外可见
  return nothing
}
