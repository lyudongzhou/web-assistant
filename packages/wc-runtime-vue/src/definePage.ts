// 把页面组件注册成业务 WC。
// shadowRoot:false —— 页面渲染在容器的 shadow root 内，共享容器注入的 UI 库样式（唯一隔离边界在容器）。
// 单副本前提下（容器与页面同批构建）不需要手动桥接 vue-router 的 symbol，app.use(router) 直接可用。
import { defineCustomElement, type App, type Component, type Plugin } from 'vue'
import type { Router } from 'vue-router'
import type { PageApi } from '@webassistant/wc-runtime-core'
import { provideRuntimeContext, type RuntimeServicesContext } from './context.js'

export type VuePlugin = Plugin | [Plugin, ...unknown[]]

/** Vue adapter 在 core 的 PageApi 上追加的框架相关能力 */
export interface VuePageApi extends PageApi {
  /** 每个页面 app 都会 app.use（element-plus / pinia / 自定义插件）——全局组件不随 provide 继承，必须逐 app 注册 */
  plugins?: VuePlugin[]
  /** 容器内建的 vue-router（页面里 useRouter() 拿到的就是它） */
  router?: Router
  /** 容器构造的 runtime context（services / state / nav / t） */
  context: RuntimeServicesContext
  /** 额外 provide（symbol 或字符串键） */
  provides?: Record<string | symbol, unknown>
  /** 完全自定义的 app 配置钩子 */
  configureApp?: (app: App, api: VuePageApi) => void
}

function applyPlugins(app: App, plugins: VuePlugin[] = []): void {
  for (const entry of plugins) {
    if (Array.isArray(entry)) app.use(entry[0], ...entry.slice(1))
    else if (entry) app.use(entry)
  }
}

/**
 * 页面 bundle 的标准写法（由 vite-plugin-wc 生成）：
 * ```js
 * import Page from '<component>'
 * import { definePage } from '@webassistant/wc-runtime-vue'
 * export const styles = Page.styles || []
 * export default (api) => definePage(Page, api)
 * ```
 */
export function definePage(component: Component, api: VuePageApi): CustomElementConstructor {
  const existing = customElements.get(api.tag)
  if (existing) return existing

  const Element = defineCustomElement(component as never, {
    shadowRoot: false,
    configureApp: (app: App) => {
      if (api.router) app.use(api.router)
      applyPlugins(app, api.plugins)
      provideRuntimeContext(app, api.context)
      for (const [key, value] of Object.entries(api.provides ?? {})) app.provide(key, value)
      api.configureApp?.(app, api)
    },
  })
  customElements.define(api.tag, Element)
  return Element
}

export default definePage
