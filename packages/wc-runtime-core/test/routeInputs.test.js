// 入参通道：manifest 的 `params[].in` 决定 agent 传的 params 走 route.params 还是 route.query。
//
// 为什么必须分流：vue-router 会**丢弃** path 里没声明的 params（Discarded invalid param），
// 所以「路径外的键值」只能通过 query 送到页面的 `route.query`（见 openspec change
// detect-route-query-params 与 packages/analyzer/src/routeScan.ts）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNavigationController } from '../dist/navigation.js'
import { resolveProps } from '../dist/props.js'

function makeRoutes() {
  return [
    {
      tag: 'datasource-admin',
      name: 'DatasourceAdmin',
      path: '/datasources',
      framework: 'vue',
      bundle: '',
      events: [],
      meta: {},
      // analyzer 探测出来的查询参数（path 里没有 :keyword / :page）
      params: [
        { name: 'keyword', type: 'string', in: 'query' },
        { name: 'page', type: 'number', in: 'query' },
      ],
      props: [
        { name: 'keyword', type: 'String' },
        { name: 'page', type: 'Number' },
      ],
    },
    {
      tag: 'user-detail',
      name: 'UserDetail',
      path: '/users/:id',
      framework: 'vue',
      bundle: '',
      events: [],
      meta: {},
      // 同名双通道：path 段 `:id` + 页面也读 route.query.id
      params: [
        { name: 'id', type: 'string' },
        { name: 'id', type: 'string', in: 'query' },
      ],
      props: [{ name: 'user', type: 'Object' }],
    },
  ]
}

test('navigation：in=query 的入参走 location.query（不进 params、不进 path）', () => {
  const nav = createNavigationController(makeRoutes())
  const result = nav.commit({ tag: 'datasource-admin', params: { keyword: '订单库', page: 2 } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.location.query, { keyword: '订单库', page: '2' })
  assert.deepEqual(result.location.params, {}, 'query 通道的键不再留在 params')
  assert.equal(result.location.path, '/datasources', 'query 不进 path 模板')
})

test('navigation：未声明的键保持旧行为（留在 params，且不进 query）', () => {
  const nav = createNavigationController(makeRoutes())
  const result = nav.commit({ tag: 'datasource-admin', params: { unknown: 'x', keyword: 'a' } })

  assert.deepEqual(result.location.params, { unknown: 'x' })
  assert.deepEqual(result.location.query, { keyword: 'a' })
})

test('navigation：query 值收口为 string / string[]（null 丢弃）', () => {
  const nav = createNavigationController(makeRoutes())
  const result = nav.commit({ tag: 'datasource-admin', params: { keyword: ['a', 'b'], page: null } })

  assert.deepEqual(result.location.query, { keyword: ['a', 'b'] })
  assert.equal('page' in result.location.query, false, 'null 等价于不传')
})

test('navigation：同名双通道（path + query）两条都下发', () => {
  const nav = createNavigationController(makeRoutes())
  const result = nav.commit({ tag: 'user-detail', params: { id: 7 } })

  assert.equal(result.location.params.id, 7)
  assert.equal(result.location.query.id, '7')
  assert.equal(result.location.path, '/users/7')
})

test('navigation：显式 target.query 优先级最高（不被 params 归一覆盖）', () => {
  const nav = createNavigationController(makeRoutes())
  const result = nav.commit({
    tag: 'datasource-admin',
    params: { keyword: 'fromParams' },
    query: { keyword: 'explicit' },
  })

  assert.equal(result.location.query.keyword, 'explicit')
})

test('navigation：query 变化算一次新导航（back 能回到上一个筛选条件）', () => {
  const nav = createNavigationController(makeRoutes())
  nav.commit({ tag: 'datasource-admin', params: { keyword: 'a' } })
  const size = nav.historySize

  nav.commit({ tag: 'datasource-admin', params: { keyword: 'b' } })
  assert.equal(nav.historySize, size + 1, '同 tag 不同 query → 新历史条目')

  const again = nav.commit({ tag: 'datasource-admin', params: { keyword: 'b' } })
  assert.equal(again.duplicated, true, 'query 完全相同时仍判重复')

  assert.equal(nav.go(-1).ok, true)
  assert.equal(nav.current.query.keyword, 'a')
})

test('resolveProps：声明过的 prop 能拿到 query 值并按 type 归一', () => {
  const route = makeRoutes()[0]
  const out = resolveProps({ route, params: {}, query: { keyword: 'x', page: '2' }, props: {} })

  assert.equal(out.keyword, 'x')
  assert.equal(out.page, 2, '按 props[].type（Number）归一')
})

test('resolveProps：未声明为 prop 的 query 键不下发（避免污染元素属性）', () => {
  const route = makeRoutes()[0]
  const out = resolveProps({ route, params: {}, query: { id: '9' }, props: {} })

  assert.deepEqual(out, {})
})

test('resolveProps：path 参数→props 的既有契约不变；params 优先于 query', () => {
  const params = [{ name: 'id', type: 'string' }]
  const route = { ...makeRoutes()[1], params, props: [{ name: 'id', type: 'String' }] }

  assert.deepEqual(resolveProps({ route, params: { id: '7' } }), { id: '7' })
  // 没有 path 参数时，query 通道可以补（页面声明了同名 prop）
  assert.deepEqual(resolveProps({ route, params: {}, query: { id: '9' } }), { id: '9' })
  assert.deepEqual(resolveProps({ route, params: { id: '1' }, query: { id: '9' } }), { id: '1' })
})
