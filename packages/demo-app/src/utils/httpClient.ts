// axios 实例（运行时容器注入给页面的 HTTP 客户端）。
// 关键点：
// 1. 拦截器在这里统一配置 —— 把每个响应自动 apiBus.report 上报给 agent（方案 B）。
// 2. 页面通过 utils/request 的 setHttp 接管，老代码 `import http` 无需改动。
// ⚠️ 不要设 baseURL：http() 的契约是「传完整 URL」（与 fetch 一致），
//    页面传 `/api/users`，axios 再设 baseURL:'/api' 会拼成 `/api/api/users`（双重前缀）。
import axios from 'axios'
import { apiBus } from '@webassistant/wc-runtime-vue'

export const httpClient = axios.create({
  timeout: 10_000,
})

httpClient.interceptors.response.use(
  (response) => {
    // 方案 B：响应数据手动上报给 agent，runtime 按 dataSources 白名单摘要
    apiBus.report({
      url: response.config.url ?? '',
      method: (response.config.method ?? 'get').toUpperCase(),
      data: response.data,
    })
    return response
  },
  (error) => Promise.reject(error),
)

export default httpClient
