// Cloudflare Pages Function：`/api/**` 的线上传输适配器（Workers 运行时）。
//
// 目录约定（Cloudflare 要求）：`functions/` 必须在**部署根**下（= packages/demo-app），
// 且不在静态根（dist/）里。路由由文件名决定：`api/[[path]].js` → 匹配 `/api` 与 `/api/**`。
// 业务逻辑全部在 ../../mock/api.js 的共享核心，这里只做「Request → 核心 → Response」的搬运。
//
// ⚠️ 无状态：Workers isolate 之间不共享内存 → 写操作（POST /api/datasources、PUT /api/settings）
//    只在当前 isolate 生命周期内可见，冷启动/换 isolate 后回到种子数据。演示可接受；
//    要持久化可接 Cloudflare KV（部署到 Pages 时再定）。
import { createMockApi } from '../../mock/api.js'

// 模块级单例：同一 isolate 内的请求复用一份数据
const mockApi = createMockApi()

export async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)

  const result = await mockApi.handle({
    method: request.method,
    pathname: decodeURIComponent(url.pathname),
    searchParams: url.searchParams,
    getHeader: (name) => request.headers.get(name),
    readBody: async () => {
      try {
        return await request.json()
      } catch {
        return {}
      }
    },
  })

  if (!result) return json({ error: 'Not found' }, 404)
  return json(result.body, result.status)
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
