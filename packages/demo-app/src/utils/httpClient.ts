// axios 实例（宿主 / 容器共用的一份 HTTP 客户端）+ **唯一**的显式上报出口 reportData。
//
// 两条链路的接入方式：
// - 用法 A（容器 / WC）：src/ce/container.ts 的 setup 里 `setHttp(adapter)`，页面 `import http` 一行不改
// - 用法 B（宿主直连）：页面直接用 utils/request 的 fetch fallback（同一个 http 契约）
//
// 上报口径（重要）：runtime **零采集** —— 不拦 fetch / XHR，没有任何「自动上报」。
// 想让 agent 看到数据，必须在调用点显式调用 reportData（或直接 apiBus.report）；不调 = 零数据出浏览器。
//   · 带 url：命中该页 manifest 的 dataSources 时，runtime 按 fields / maxRows / mask 摘要后才出网
//   · 不带 url：原样透传（调用点已自己挑过字段）
// ⚠️ 不要设 baseURL：http() 的契约是「传完整 URL」（与 fetch 一致），
//    页面传 `/api/users`，axios 再设 baseURL:'/api' 会拼成 `/api/api/users`（双重前缀）。
import axios from 'axios'
import { apiBus } from '@webassistant/wc-runtime-vue'

export const httpClient = axios.create({
  timeout: 10_000,
})

export interface ReportOptions {
  /** 原始请求 URL —— 给了才能命中 manifest `dataSources` 的白名单裁剪 */
  url?: string
  /** HTTP 方法（可选，仅作上下文） */
  method?: string
}

/**
 * 显式上报一份数据给 agent —— **可选动作，按需调用**。
 *
 * @param source  来源标识（未命中 dataSources 时，会出现在 agent prompt 的「来源：」处）
 * @param data    要给 agent 看的数据；声明了 dataSources 的接口可直接报原始响应（裁剪交给声明）
 * @param options 带 url 才能命中 dataSources 白名单；不带则原样透传
 * @returns 是否有 runtime 在监听（false = 当前没有 assistant，上报被丢弃，无副作用）
 */
export function reportData(source: string, data: unknown, options: ReportOptions = {}): boolean {
  const accepted = apiBus.report({ source, data, url: options.url, method: options.method })
  if (!accepted && import.meta.env.DEV) {
    // 开发期自检：没有 runtime 监听时上报会被**静默丢弃**（典型：页面跑在「没挂助手」的 SPA 里）
    console.debug(`[report] 没有 runtime 监听，已丢弃 source=${source}`)
  }
  return accepted
}

export default httpClient
