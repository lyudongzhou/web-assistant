/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

declare module '*.css?inline' {
  const css: string
  export default css
}

/**
 * 本包自用的 Vite 环境变量（构建期注入）。
 * 增补 Vite 的 `ImportMetaEnv`（vite/client 已把该接口声明为全局，这里做接口合并）。
 */
interface ImportMetaEnv {
  /** agent-server 的 WebSocket 地址前缀（缺省 '/ws'；生产填绝对地址，如 wss://…/ws） */
  readonly VITE_WS_BASE?: string
}
