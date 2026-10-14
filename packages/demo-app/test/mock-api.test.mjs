// mock 后端共享核心（mock/api.js）+ Pages Function 适配器（functions/api/[[path]].js）的行为锁。
//
// 为什么要有它：mock 逻辑从 serve.mjs 抽出成「共享核心 + 两个适配器」后，本地与线上读的是同一份代码；
// 这些断言把「抽取前 ↔ 抽取后」的行为等价性钉住（路由 / 白名单字段 / 错误注入 / 需要 Authorization 的接口）。
//
// 用法：pnpm --filter demo-app test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockApi } from '../mock/api.js'
import { onRequest } from '../functions/api/[[path]].js'

/** 直接驱动共享核心（不经过任何 HTTP 服务器） */
function coreCall(api, method, rawPath, { headers = {}, body } = {}) {
  const url = new URL(rawPath, 'http://localhost')
  return api.handle({
    method,
    pathname: decodeURIComponent(url.pathname),
    searchParams: url.searchParams,
    getHeader: (name) => headers[name] ?? headers[name?.toLowerCase()] ?? null,
    readBody: async () => body ?? {},
  })
}

// ── 共享核心 ──────────────────────────────────────────────────────────
test('核心：GET /api/users 返回 12 条（故意多于 maxRows=6）', async () => {
  const r = await coreCall(createMockApi(), 'GET', '/api/users')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 12)
})

test('核心：GET /api/users?keyword= 按 name/email 过滤', async () => {
  const r = await coreCall(createMockApi(), 'GET', '/api/users?keyword=%E6%9D%8E%E5%9B%9B')
  assert.equal(r.body.length, 1)
  assert.equal(r.body[0].name, '李四')
})

test('核心：GET/PUT/DELETE /api/users/:id（PUT 合并且 id 不可改）', async () => {
  const api = createMockApi()

  const got = await coreCall(api, 'GET', '/api/users/2')
  assert.equal(got.body.id, 2)

  const put = await coreCall(api, 'PUT', '/api/users/2', { body: { name: '李四改', id: 99 } })
  assert.equal(put.body.name, '李四改')
  assert.equal(put.body.id, 2, 'id 不能被 body 覆盖')

  const del = await coreCall(api, 'DELETE', '/api/users/2')
  assert.equal(del.body.ok, true)
  const missing = await coreCall(api, 'GET', '/api/users/2')
  assert.equal(missing.status, 404)
})

test('核心：POST /api/users 自增 id + 201', async () => {
  const api = createMockApi()
  const r = await coreCall(api, 'POST', '/api/users', { body: { name: '新人' } })
  assert.equal(r.status, 201)
  assert.equal(r.body.id, 13)
})

test('核心：订单列表按 status 过滤 + 详情 404', async () => {
  const api = createMockApi()
  const paid = await coreCall(api, 'GET', '/api/orders?status=paid')
  assert.ok(paid.body.length > 0 && paid.body.every((o) => o.status === 'paid'))

  const one = await coreCall(api, 'GET', '/api/orders/SO-1001')
  assert.equal(one.body.id, 'SO-1001')

  const missing = await coreCall(api, 'GET', '/api/orders/NOPE')
  assert.equal(missing.status, 404)
})

test('核心：GET /api/stats/overview 4 指标 + 7 趋势点', async () => {
  const r = await coreCall(createMockApi(), 'GET', '/api/stats/overview')
  assert.equal(r.body.stats.length, 4)
  assert.equal(r.body.trend.length, 7)
})

test('核心：数据源 POST 落库（同实例后续 GET 能看到）', async () => {
  const api = createMockApi()
  const before = await coreCall(api, 'GET', '/api/datasources')
  assert.equal(before.body.length, 5)

  const created = await coreCall(api, 'POST', '/api/datasources', { body: { name: '新建库' } })
  assert.equal(created.status, 201)
  assert.equal(created.body.id, 6)

  const after = await coreCall(api, 'GET', '/api/datasources')
  assert.equal(after.body.length, 6)
})

test('核心：/api/settings 需要 Authorization；PUT 保留只读 version', async () => {
  const api = createMockApi()

  const anon = await coreCall(api, 'GET', '/api/settings')
  assert.equal(anon.status, 401)

  const auth = await coreCall(api, 'GET', '/api/settings', { headers: { authorization: 'Bearer x' } })
  assert.equal(auth.status, 200)

  const put = await coreCall(api, 'PUT', '/api/settings', {
    headers: { authorization: 'Bearer x' },
    body: { siteName: '改过了', version: 'hack' },
  })
  assert.equal(put.body.siteName, '改过了')
  assert.equal(put.body.version, 'demo-1.0.0', 'version 是服务端只读项')
})

test('核心：会话 login / whoami', async () => {
  const api = createMockApi()
  const login = await coreCall(api, 'POST', '/api/login', { body: { name: '王五' } })
  assert.equal(login.body.user.name, '王五')
  assert.match(login.body.token, /^demo-token-王五-/)

  const who = await coreCall(api, 'GET', '/api/whoami', { headers: { authorization: 'Bearer x' } })
  assert.equal(who.body.authorization, 'Bearer x')
})

test('核心：未知 /api 路由返回 null（交给调用方 404）', async () => {
  const r = await coreCall(createMockApi(), 'GET', '/api/nope')
  assert.equal(r, null)
})

test('核心：错误注入 ?fail=500 / ?fail=401 / ?fail=slow', async () => {
  const api = createMockApi()
  assert.equal((await coreCall(api, 'GET', '/api/users?fail=500')).status, 500)
  assert.equal((await coreCall(api, 'GET', '/api/users?fail=401')).status, 401)

  const t0 = Date.now()
  const slow = await coreCall(api, 'GET', '/api/users', { headers: { 'x-mock-fail': 'slow' } })
  assert.equal(slow.status, 200)
  assert.ok(Date.now() - t0 >= 3_000, 'slow 应先延迟再正常返回')
})

// ── Pages Function 适配器（Web 标准 Request/Response）─────────────────
const fnCall = (method, url, { headers, body } = {}) =>
  onRequest({
    request: new Request(url, {
      method,
      headers: headers ? { 'Content-Type': 'application/json', ...headers } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  })

test('Function：GET /api/users → 200 + JSON 头 + 12 条', async () => {
  const res = await fnCall('GET', 'http://demo/api/users')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /application\/json/)
  assert.equal((await res.json()).length, 12)
})

test('Function：写操作（POST /api/datasources → 201）', async () => {
  const res = await fnCall('POST', 'http://demo/api/datasources', { body: { name: 'Function 新建' } })
  assert.equal(res.status, 201)
  assert.equal((await res.json()).name, 'Function 新建')
})

test('Function：/api/settings 无 auth → 401，带 auth → 200', async () => {
  assert.equal((await fnCall('GET', 'http://demo/api/settings')).status, 401)
  const ok = await fnCall('GET', 'http://demo/api/settings', { headers: { authorization: 'Bearer x' } })
  assert.equal(ok.status, 200)
})

test('Function：未知 /api 路由 → 404', async () => {
  assert.equal((await fnCall('GET', 'http://demo/api/unknown')).status, 404)
})

test('Function：?fail=500 透传', async () => {
  assert.equal((await fnCall('GET', 'http://demo/api/users?fail=500')).status, 500)
})
