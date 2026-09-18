// demo-app 的本地 mock 后端 + 静态预览（8080）。
//
//   pnpm --filter demo-app preview:ce      # 或 pnpm preview:ce
//
// 两条职责：
//   ① /api/**  —— 内存数据集（用户 / 订单 / 指标 / 数据源 / 设置）+ 筛选 + **错误注入**
//      · 错误注入：任何 /api 请求带 `?fail=500` / `?fail=401` / `?fail=slow` 即触发，
//        用来演示「接口失败也要让 agent 看见」的异常链路（页面会在 catch 里上报错误）
//      · /api/settings 需要 `Authorization`（演示宿主 store 的 token → 请求头链路）
//   ② 其余路径 —— demo-app 目录的静态文件（`/` → wc-demo.html；`/wc-ce/dist-ce/**` → dist-ce/**）
//
// 数据全部是演示数据（规则 rules/domain.md 也要求：不得描述成生产数据）。
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ── 演示数据 ──────────────────────────────────────────────────────────
const roles = ['管理员', '普通用户', '访客']

/** 12 个用户：故意多于 user-list 的 dataSources.maxRows=6，用来演示「有界上报截断」 */
const users = Array.from({ length: 12 }, (_, index) => {
  const id = index + 1
  const names = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十', '郑一', '王一', '冯二', '陈三']
  return {
    id,
    name: names[index],
    email: `user${id}@example.com`,
    role: roles[index % roles.length],
    lastLoginAt: new Date(Date.now() - id * 3600_000).toISOString(),
  }
})

const orderStatuses = ['pending', 'paid', 'shipped', 'done', 'canceled']

/** 10 个订单：userId 落在用户表内，供「用户 → 订单」跨页链路使用 */
const orders = Array.from({ length: 10 }, (_, index) => {
  const id = index + 1
  const user = users[index % 6]
  return {
    id: `SO-${1000 + id}`,
    customer: user.name,
    userId: user.id,
    amount: Number((68 + id * 37.5).toFixed(2)),
    status: orderStatuses[index % orderStatuses.length],
    createdAt: new Date(Date.now() - id * 7200_000).toISOString(),
  }
})

/** 数据源（字段结构与 src/types/datasource.ts 的 DatasourceVO 对齐） */
const datasources = [
  { id: 1, name: '主库', host: '10.0.0.1', port: 3306, tags: ['prod'], enabled: true, status: 'active', kind: 'mysql', owner: { id: 1, displayName: '张三' } },
  { id: 2, name: '缓存', host: '10.0.0.2', port: 6379, tags: ['prod'], enabled: true, status: 'active', kind: 'redis', owner: { id: 2, displayName: '李四' } },
  { id: 3, name: '报表库', host: '10.0.0.3', port: 3306, tags: ['bi'], enabled: true, status: 'active', kind: 'mysql', owner: { id: 3, displayName: '王五' } },
  { id: 4, name: '归档库', host: '10.0.0.4', port: 3306, tags: ['archive'], enabled: false, status: 'disabled', kind: 'mysql', owner: null },
  { id: 5, name: '会话缓存', host: '10.0.0.5', port: 6379, tags: ['session'], enabled: true, status: 'active', kind: 'redis', owner: { id: 1, displayName: '张三' } },
]

const settings = {
  siteName: 'WebAssistant 演示后台',
  locale: 'zh-CN',
  notify: true,
  version: 'demo-1.0.0',
}

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

/** 错误注入：返回 true 表示已经接管响应，调用方直接 return */
async function injectFailure(req, res, url) {
  const mode = url.searchParams.get('fail') || req.headers['x-mock-fail']
  if (!mode) return false
  if (mode === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    return false
  }
  if (mode === '401') {
    json(res, { error: 'mock 注入：未授权（401）' }, 401)
    return true
  }
  json(res, { error: 'mock 注入：服务端错误（500）' }, 500)
  return true
}

const trendLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const method = req.method
  if (await injectFailure(req, res, url)) return true

  // —— 会话 ——
  if (path === '/api/login' && method === 'POST') {
    const body = await readBody(req)
    const name = body.name || '张三'
    json(res, { token: `demo-token-${name}-${Date.now()}`, user: { name, role: '管理员' } })
    return true
  }
  if (path === '/api/whoami' && method === 'GET') {
    json(res, { authorization: req.headers.authorization ?? null, at: Date.now() })
    return true
  }

  // —— 用户 ——
  if (path === '/api/users' && method === 'GET') {
    const keyword = (url.searchParams.get('keyword') || '').toLowerCase()
    const list = keyword
      ? users.filter(
          (user) =>
            user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword),
        )
      : users
    json(res, list)
    return true
  }
  if (path === '/api/users' && method === 'POST') {
    const body = await readBody(req)
    const created = {
      id: Math.max(...users.map((user) => user.id)) + 1,
      name: body.name || '未命名用户',
      email: body.email || 'new@example.com',
      role: body.role || '普通用户',
      lastLoginAt: new Date().toISOString(),
    }
    users.push(created)
    json(res, created, 201)
    return true
  }
  const userMatch = path.match(/^\/api\/users\/(\d+)$/)
  if (userMatch) {
    const index = users.findIndex((user) => user.id === Number(userMatch[1]))
    if (index < 0) {
      json(res, { error: `未找到用户 id=${userMatch[1]}` }, 404)
      return true
    }
    if (method === 'GET') {
      json(res, users[index])
      return true
    }
    if (method === 'PUT') {
      const body = await readBody(req)
      users[index] = { ...users[index], ...body, id: users[index].id }
      json(res, users[index])
      return true
    }
    if (method === 'DELETE') {
      users.splice(index, 1)
      json(res, { ok: true })
      return true
    }
  }

  // —— 订单 ——
  if (path === '/api/orders' && method === 'GET') {
    const status = url.searchParams.get('status')
    json(res, status ? orders.filter((order) => order.status === status) : orders)
    return true
  }
  const orderMatch = path.match(/^\/api\/orders\/([\w-]+)$/)
  if (orderMatch && method === 'GET') {
    const order = orders.find((item) => item.id === orderMatch[1])
    if (order) json(res, order)
    else json(res, { error: `未找到订单 ${orderMatch[1]}` }, 404)
    return true
  }

  // —— 指标 ——
  if (path === '/api/stats/overview' && method === 'GET') {
    json(res, {
      stats: [
        { key: 'users', label: '用户总数', value: String(users.length) },
        { key: 'orders', label: '订单数', value: String(orders.length) },
        { key: 'gmv', label: '成交额', value: `￥${orders.reduce((sum, order) => sum + order.amount, 0).toFixed(0)}` },
        { key: 'active', label: '今日活跃', value: '42' },
      ],
      trend: trendLabels.map((label, index) => ({
        date: label,
        orders: 12 + ((index * 7) % 23),
        gmv: 1800 + index * 260,
      })),
      updatedAt: new Date().toISOString(),
    })
    return true
  }

  // —— 数据源 ——
  if (path === '/api/datasources' && method === 'GET') {
    json(res, datasources)
    return true
  }
  if (path === '/api/datasources' && method === 'POST') {
    const body = await readBody(req)
    const created = {
      id: Math.max(...datasources.map((item) => item.id)) + 1,
      name: body.name || '未命名数据源',
      host: body.host || '127.0.0.1',
      port: body.port || 3306,
      tags: body.tags || [],
      enabled: true,
      status: body.status || 'active',
      kind: body.kind || 'mysql',
      owner: body.owner ?? null,
    }
    datasources.push(created)
    json(res, created, 201)
    return true
  }

  // —— 设置（需要 Authorization：演示登录守卫 + token 链路）——
  if (path === '/api/settings') {
    if (!req.headers.authorization) {
      json(res, { error: '未授权：请先登录（缺少 Authorization 头）' }, 401)
      return true
    }
    if (method === 'GET') {
      json(res, settings)
      return true
    }
    if (method === 'PUT') {
      const body = await readBody(req)
      Object.assign(settings, body, { version: settings.version })
      json(res, settings)
      return true
    }
  }

  return false
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

server.listen(8080, () => {
  console.log('Serving at http://localhost:8080 (mock API + 静态预览)')
  console.log(`  mock 数据：${users.length} 用户 / ${orders.length} 订单 / ${datasources.length} 数据源`)
  console.log('  错误注入：任意 /api 请求加 ?fail=500 | ?fail=401 | ?fail=slow')
})

