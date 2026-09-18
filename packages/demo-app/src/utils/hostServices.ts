// 宿主注入给页面的**框架无关**能力（request / getToken / t / emit）。
//
// 两处都用它，保证口径一致：
//   - 用法 B（宿主直连）：createVueHostRuntimeBinding({ services }) → 页面 useRuntimeServices()
//   - 用法 A（容器 / WC）：<WebAssistant :services>  → 容器透传给页面
//
// ⚠️ 必须是**纯函数 / 纯数据**：传 pinia store 或 i18n 实例会让「跨副本响应式不互通」
//    （页面首次能读到值，之后宿主改了不更新）—— 所以这里给的是按需现读的闭包。
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { translate } from './i18n'
import type { Locale } from '../api/types'

export function hostServices() {
  return {
    /** 每次请求现读（不要在容器里捕获成局部变量 → stale） */
    getToken: () => useAuthStore().token,
    /** 翻译函数：内部现读当前语言，切语言后页面重渲染即跟着变 */
    t: (key: string) => translate(useAppStore().locale as Locale, key),
    /** 页面 → 宿主（宿主可再转发给 agent；host 模式下页面还可直接用 ctx.emit 走通知面） */
    emit: (event: string, payload?: unknown) => console.debug('[host-page-emit]', event, payload),
  }
}
