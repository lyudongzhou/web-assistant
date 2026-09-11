// 极简静态服务器：用于本地预览 Web Component 构建产物 + mock API
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

// ── Mock 数据（页面通过 fetch 访问，NetworkObserver 透明拦截） ──────────
const mockUsers = [
  { id: 1, name: '张三', email: 'zhangsan@example.com', role: '管理员' },
  { id: 2, name: '李四', email: 'lisi@example.com', role: '普通用户' },
  { id: 3, name: '王五', email: 'wangwu@example.com', role: '普通用户' },
  { id: 4, name: '赵六', email: 'zhaoliu@example.com', role: '访客' },
  { id: 5, name: '钱七', email: 'qianqi@example.com', role: '管理员' },
  { id: 6, name: '孙八', email: 'sunba@example.com', role: '访客' },
  { id: 7, name: '周九', email: 'zhoujiu@example.com', role: '普通用户' },
]

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname

  // GET /api/users  —— 可选 ?name=xxx 过滤
  if (path === '/api/users' && req.method === 'GET') {
    const name = url.searchParams.get('name')
    let users = mockUsers
    if (name) {
      const kw = name.toLowerCase()
      users = mockUsers.filter(u => u.name.toLowerCase().includes(kw) || u.email.toLowerCase().includes(kw))
    }
    json(res, users)
    return true
  }

  // GET /api/users/:id
  const match = path.match(/^\/api\/users\/(\d+)$/)
  if (match && req.method === 'GET') {
    const user = mockUsers.find(u => u.id === Number(match[1]))
    if (user) json(res, user)
    else json(res, { error: 'User not found' }, 404)
    return true
  }

  return false
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)

    // mock API 优先处理
    if (pathname.startsWith('/api/')) {
      if (handleApi(req, res)) return
    }

    if (pathname === '/') pathname = '/wc-demo.html'
    const filePath = normalize(join(root, pathname))
    if (!filePath.startsWith(root)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    const data = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': mime[extname(filePath)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
})

server.listen(8080, () => console.log('Serving at http://localhost:8080 (mock API + static)'))
