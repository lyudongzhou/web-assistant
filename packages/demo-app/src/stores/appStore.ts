// 演示应用自己的偏好设置（界面语言 / 站点名）。
//
// 为什么单独一个 store：宿主注入的 `services.t` 需要一个「当前语言」的真相源，
// 而 services 必须是框架无关的纯函数 —— 所以让它闭包读本 store 的 state，而不是把 i18n 实例传进去
// （传实例会让「跨副本响应式不互通」，见 docs/INTEGRATION_GUIDE.md 第 1 节）。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Locale } from '../api/types'

export const useAppStore = defineStore('app', () => {
  const locale = ref<Locale>('zh-CN')
  const siteName = ref('WebAssistant 演示后台')

  function setLocale(next: Locale): void {
    locale.value = next
  }

  function setSiteName(next: string): void {
    siteName.value = next
  }

  return { locale, siteName, setLocale, setSiteName }
})
