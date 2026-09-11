// 页面 emit 回传宿主的载荷。
// 链路：页面 emit('save', data) → Vue CE 派发 CustomEvent（composed:false，停在容器 shadow root 内）
//       → 容器按 view.events 挂的监听 → runtime 'page-event' → 宿主（可再转发给 agent 的 POST /event）
export interface PageEventPayload {
  /** 触发事件的页面标签 */
  tag: string
  /** 事件名（manifest.pages[].events 里声明的） */
  event: string
  /** CustomEvent.detail */
  payload?: unknown
}
