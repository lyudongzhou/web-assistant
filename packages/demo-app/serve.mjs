// demo-app 的本地 mock 后端 + 静态预览（8080）。
//
//   pnpm --filter demo-app preview:ce      # 或 pnpm preview:ce
//
// 两条职责：
//   ① /api/**  —— 复用 ./mock/api.js 的共享核心（与线上 Cloudflare Pages Function 同一份逻辑，
//      见 functions/api/[[path]].js）；错误注入也在核心里。
//      · 错误注入：任何 /api 请求带 `?fail=500` / `?fail=401` / `?fail=slow` 即触发，
//        用来演示「接口失败也要让 agent 看见」的异常链路（页面会在 catch 里上报错误）
//      · /api/settings 需要 `Authorization`（演示宿主 store 的 token → 请求头链路）
//   ② 其余路径 —— demo-app 目录的静态文件（`/` → wc-demo.html；`/wc/dist-ce/**` → dist-ce/**）
//
// 数据全部是演示数据（规则 rules/domain.md 也要求：不得描述成生产数据）。
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockApi } from './mock/api.js'

const root = fileURLToPath(new URL('.', import.meta.url))
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

// mock 后端实例：数据与路由都在 mock/api.js，这里只做 node:http 适配
const mockApi = createMockApi()

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

/** node:http 适配器：把请求搬进共享核心，再把结果写回响应；返回 false = 不是 /api 路由 */
async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const result = await mockApi.handle({
    method: req.method,
    pathname: decodeURIComponent(url.pathname),
    searchParams: url.searchParams,
    getHeader: (name) => req.headers[name],
    readBody: () => readBody(req),
  })
  if (!result) return false
  json(res, result.body, result.status)
  return true
}

// ── HTTP server：API 优先，其余走静态文件 ──────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)

    if (pathname.startsWith('/api/')) {
      if (await handleApi(req, res)) return
    }

    // 默认入口：runtime 层验收台
    if (pathname === '/') pathname = '/wc-demo.html'
    // WC 批次产物：URL 前缀 `/wc/dist-ce` ↔ 真实目录 `dist-ce`
    //（与 demo-app/vite.config.ts 里 wcCeAssets() 中间件的映射一致；产物不放 public/，见那里的注释）
    if (pathname.startsWith('/wc/dist-ce/')) {
      pathname = pathname.replace('/wc/dist-ce/', '/dist-ce/')
    }

    let filePath = normalize(join(root, pathname))
    if (!filePath.startsWith(root)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    let data
    try {
      data = await readFile(filePath)
    } catch (cause) {
      // vite dev 把 `public/**` 当同源根路径提供（`/wc/manifest.json` 等），静态服务器补一层回退：
      // 根目录找不到时再试 public/（否则 8080 上 manifest 会 404）
      filePath = normalize(join(root, 'public', pathname))
      if (!filePath.startsWith(root)) throw cause
      data = await readFile(filePath)
    }
    res.writeHead(200, { 'Content-Type': mime[extname(filePath)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
})

// PORT 可覆盖（默认 8080，与 README/代理约定一致）；便于多实例/CI 跑
const port = Number(process.env.PORT || 8080)
server.listen(port, () => {
  const { users, orders, datasources } = mockApi.stats()
  console.log(`Serving at http://localhost:${port} (mock API + 静态预览)`)
  console.log(`  mock 数据：${users} 用户 / ${orders} 订单 / ${datasources} 数据源`)
  console.log('  错误注入：任意 /api 请求加 ?fail=500 | ?fail=401 | ?fail=slow')
})
