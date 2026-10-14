// demo-app 的 mock 后端「共享核心」：纯数据 + 路由，零传输依赖。
//
// 两个传输适配器复用同一份逻辑（避免本地/线上漂移）：
//   - 本地：packages/demo-app/serve.mjs（node:http 适配器）
//   - 线上：packages/demo-app/functions/api/[[path]].js（Cloudflare Pages Function / Workers 适配器）
//
// 契约：createMockApi().handle(request) → Promise<{ status, body } | null>
//   · request = { method, pathname, searchParams, getHeader(name), readBody() }
//   · null = 不是已知的 /api 路由（调用方自行 404 / 交给静态处理）
//
// 数据全部是演示数据（规则 rules/domain.md 也要求：不得描述成生产数据）。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ROLES = ['管理员', '普通用户', '访客']
const TREND_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'done', 'canceled']

/** 建一套内存数据集（每个实例独立 → 便于测试隔离；线上 isolate 生命周期内可见） */
function seed() {
  /** 12 个用户：故意多于 user-list 的 dataSources.maxRows=6，用来演示「有界上报截断」 */
  const users = Array.from({ length: 12 }, (_, index) => {
    const id = index + 1
    const names = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十', '郑一', '王一', '冯二', '陈三']
    return {
      id,
      name: names[index],
      email: `user${id}@example.com`,
      role: ROLES[index % ROLES.length],
      lastLoginAt: new Date(Date.now() - id * 3600_000).toISOString(),
    }
  })

  /** 10 个订单：userId 落在用户表内，供「用户 → 订单」跨页链路使用 */
  const orders = Array.from({ length: 10 }, (_, index) => {
    const id = index + 1
    const user = users[index % 6]
    return {
      id: `SO-${1000 + id}`,
      customer: user.name,
      userId: user.id,
      amount: Number((68 + id * 37.5).toFixed(2)),
      status: ORDER_STATUSES[index % ORDER_STATUSES.length],
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

  return { users, orders, datasources, settings }
}

const ok = (body) => ({ status: 200, body })

/**
 * 建一个 mock API 实例（自带一份内存数据集）。
 *
 * @returns {{
 *   handle: (request: {
 *     method?: string,
 *     pathname: string,
 *     searchParams: URLSearchParams,
 *     getHeader: (name: string) => string | null | undefined,
 *     readBody: () => Promise<Record<string, unknown>>,
 *   }) => Promise<{ status: number, body: unknown } | null>,
 *   stats: () => { users: number, orders: number, datasources: number },
 * }}
 */
export function createMockApi() {
  const state = seed()

  async function handle(request) {
    const { method = 'GET', pathname, searchParams, getHeader, readBody } = request

    // —— 错误注入：演示「接口失败也要让 agent 看见」的异常链路 ——
    // slow：延迟后继续走正常路由；401 / 其它任意值：直接短路成错误响应
    const fail = searchParams.get('fail') || getHeader('x-mock-fail') || ''
    if (fail === 'slow') await sleep(3_500)
    else if (fail === '401') return { status: 401, body: { error: 'mock 注入：未授权（401）' } }
    else if (fail) return { status: 500, body: { error: 'mock 注入：服务端错误（500）' } }

    return route({ method, pathname, searchParams, getHeader, readBody })
  }

  /** 返回 null = 未知 /api 路由（调用方自行 404） */
  async function route({ method, pathname, searchParams, getHeader, readBody }) {
    const { users, orders, datasources, settings } = state

    // —— 会话 ——
    if (pathname === '/api/login' && method === 'POST') {
      const body = await readBody()
      const name = body.name || '张三'
      return ok({ token: `demo-token-${name}-${Date.now()}`, user: { name, role: '管理员' } })
    }
    if (pathname === '/api/whoami' && method === 'GET') {
      return ok({ authorization: getHeader('authorization') ?? null, at: Date.now() })
    }

    // —— 用户 ——
    if (pathname === '/api/users' && method === 'GET') {
      const keyword = (searchParams.get('keyword') || '').toLowerCase()
      const list = keyword
        ? users.filter(
            (user) =>
              user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword),
          )
        : users
      return ok(list)
    }
    if (pathname === '/api/users' && method === 'POST') {
      const body = await readBody()
      const created = {
        id: Math.max(...users.map((user) => user.id)) + 1,
        name: body.name || '未命名用户',
        email: body.email || 'new@example.com',
        role: body.role || '普通用户',
        lastLoginAt: new Date().toISOString(),
      }
      users.push(created)
      return { status: 201, body: created }
    }
    const userMatch = pathname.match(/^\/api\/users\/(\d+)$/)
    if (userMatch) {
      const index = users.findIndex((user) => user.id === Number(userMatch[1]))
      if (index < 0) return { status: 404, body: { error: `未找到用户 id=${userMatch[1]}` } }
      if (method === 'GET') return ok(users[index])
      if (method === 'PUT') {
        const body = await readBody()
        users[index] = { ...users[index], ...body, id: users[index].id }
        return ok(users[index])
      }
      if (method === 'DELETE') {
        users.splice(index, 1)
        return ok({ ok: true })
      }
    }

    // —— 订单 ——
    if (pathname === '/api/orders' && method === 'GET') {
      const status = searchParams.get('status')
      return ok(status ? orders.filter((order) => order.status === status) : orders)
    }
    const orderMatch = pathname.match(/^\/api\/orders\/([\w-]+)$/)
    if (orderMatch && method === 'GET') {
      const order = orders.find((item) => item.id === orderMatch[1])
      return order ? ok(order) : { status: 404, body: { error: `未找到订单 ${orderMatch[1]}` } }
    }

    // —— 指标 ——
    if (pathname === '/api/stats/overview' && method === 'GET') {
      return ok({
        stats: [
          { key: 'users', label: '用户总数', value: String(users.length) },
          { key: 'orders', label: '订单数', value: String(orders.length) },
          { key: 'gmv', label: '成交额', value: `￥${orders.reduce((sum, order) => sum + order.amount, 0).toFixed(0)}` },
          { key: 'active', label: '今日活跃', value: '42' },
        ],
        trend: TREND_LABELS.map((label, index) => ({
          date: label,
          orders: 12 + ((index * 7) % 23),
          gmv: 1800 + index * 260,
        })),
        updatedAt: new Date().toISOString(),
      })
    }

    // —— 数据源 ——
    if (pathname === '/api/datasources' && method === 'GET') return ok(datasources)
    if (pathname === '/api/datasources' && method === 'POST') {
      const body = await readBody()
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
      return { status: 201, body: created }
    }

    // —— 设置（需要 Authorization：演示登录守卫 + token 链路）——
    if (pathname === '/api/settings') {
      if (!getHeader('authorization')) {
        return { status: 401, body: { error: '未授权：请先登录（缺少 Authorization 头）' } }
      }
      if (method === 'GET') return ok(settings)
      if (method === 'PUT') {
        const body = await readBody()
        Object.assign(settings, body, { version: settings.version })
        return ok(settings)
      }
    }

    return null
  }

  return {
    handle,
    /** 数据集规模（本地服务器启动日志用） */
    stats: () => ({
      users: state.users.length,
      orders: state.orders.length,
      datasources: state.datasources.length,
    }),
  }
}
