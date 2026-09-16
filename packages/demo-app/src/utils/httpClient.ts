// axios 实例（运行时容器注入给页面的 HTTP 客户端）。
// 关键点：
// 1. **不做自动上报**：runtime 不采集任何请求，agent 能看到什么完全由调用点在业务代码里显式决定
//    （用下面的 reportData，或直接 apiBus.report）；不调 = 零数据出浏览器。
// 2. 页面通过 utils/request 的 setHttp 接管，老代码 `import http` 无需改动。
// ⚠️ 不要设 baseURL：http() 的契约是「传完整 URL」（与 fetch 一致），
//    页面传 `/api/users`，axios 再设 baseURL:'/api' 会拼成 `/api/api/users`（双重前缀）。
import axios from 'axios'
import { apiBus } from '@webassistant/wc-runtime-vue'

export const httpClient = axios.create({
  timeout: 10_000,
})

/**
 * 显式上报一份数据给 agent —— **可选动作，按需调用**。
 *
 * 为什么是手动：runtime 不拦截 fetch / XHR、不自动上报任何请求；数据出网的决定权在调用点。
 * 只有调了这里（或直接 `apiBus.report`），agent 才看得到；不调 = 零数据出浏览器。
 *
 * @param source 来源标识（会出现在 agent prompt 的「来源：」处；建议用页面名或接口名）
 * @param data   你愿意公开的数据 —— **先自己挑字段**，不要把整个响应原样丢进来
 * @returns 是否有 runtime 在监听（false = 当前没有 assistant，上报被丢弃，无副作用）
 */
export function reportData(source: string, data: unknown): boolean {
  return apiBus.report({ source, data })
}

export default httpClient
