// 渲染指令类型（供 useAgentChat 的 tool.call 参数使用）。
// 旧的 SSE 协议（AGENT_EVENT / AgentTextEvent / AgentDoneEvent 等）已废弃，
// 对话链路改为 WebSocket，见 @webassistant/protocol/websocket。

/** 渲染指令：page 是页面的自定义元素标签 */
export interface AgentRenderEvent {
  type: 'render'
  data: {
    page: string
    params?: Record<string, unknown>
    /** 兼容 agent 直接传 props 的写法 */
    props?: Record<string, unknown>
    title?: string
  }
}
