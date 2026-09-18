// 对话投影（纯函数，零依赖）：把 runtime 的完整 transcript 投影成「本次模型请求」要用的消息列表。
//
// 为什么需要投影：
//   1. 长驻 agent runtime 的 transcript 随对话线性增长 → 每轮 token 成本无界上升；
//   2. 工具调用与其结果是**成对**的（provider 要求），拦腰截断会产生不合法序列。
//
// 投影只作用于当次 provider 请求（AgentRuntime 的 prepareTurn 语义），
// 不修改 runtime 的 canonical transcript（完整轨迹仍保留，便于调试与日志）。

/** 结构化部件视图：只关心 content 里有什么 tool 部件（不 import SDK 内部类型，便于单测）。 */
export interface ProjectablePart {
  type: string
  toolCallId?: string
}

export interface ProjectableMessage {
  content: readonly ProjectablePart[]
}

/** 单次请求投影的消息上限（env `MAX_TURN_MESSAGES` 可覆盖）。 */
export const DEFAULT_MAX_TURN_MESSAGES = 24

/**
 * 保留最近 `maxMessages` 条消息，并保证工具调用/结果成对：
 * 若窗口首条含「tool-result 在、对应 tool-call 已被截掉」的孤儿部件，则继续往后推窗口，
 * 直到窗口首条不再出现孤儿部件（至少保留最后一条消息）。
 */
export function projectTurnMessages<T extends ProjectableMessage>(
  messages: readonly T[],
  maxMessages: number = DEFAULT_MAX_TURN_MESSAGES,
): T[] {
  if (messages.length <= maxMessages) return [...messages]
  const limit = Math.max(1, Math.floor(maxMessages))
  let start = messages.length - limit
  while (start < messages.length - 1) {
    const callIds = new Set<string>()
    for (let i = start; i < messages.length; i += 1) {
      for (const part of messages[i].content) {
        if (part.type === 'tool-call' && part.toolCallId) callIds.add(part.toolCallId)
      }
    }
    const orphan = messages[start].content.some(
      (part) => part.type === 'tool-result' && !!part.toolCallId && !callIds.has(part.toolCallId),
    )
    if (!orphan) break
    start += 1
  }
  return messages.slice(start)
}
