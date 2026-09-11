import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNavigationController, fillPath, parseParams } from '../dist/navigation.js'
import { normalizeManifest } from '../dist/manifest.js'
import { makeManifest } from './helpers.js'

const routes = () => normalizeManifest(makeManifest()).routes

test('navigation：tag / name / path 三种寻址', () => {
  const nav = createNavigationController(routes())
  assert.equal(nav.commit({ tag: 'user-list' }).ok, true)
  assert.equal(nav.current.tag, 'user-list')
  assert.equal(nav.commit({ name: 'UserDetail', params: { id: 3 } }).ok, true)
  assert.equal(nav.current.tag, 'user-detail')
  const byPath = nav.commit({ path: '/users/7' })
  assert.equal(byPath.ok, true)
  assert.equal(byPath.location.params.id, '7')
})

test('navigation：path 与 params 双向（生成 + 反解）', () => {
  assert.equal(fillPath('/users/:id', { id: 9 }), '/users/9')
  assert.deepEqual(parseParams('/users/:id', '/users/9'), { id: '9' })
  assert.equal(parseParams('/users/:id', '/orders/9'), null)
  const nav = createNavigationController(routes())
  const r = nav.commit({ tag: 'user-detail', params: { id: 12 } })
  assert.equal(r.location.path, '/users/12')
})

test('navigation：query 解析（path 上的 ?a=1&a=2）', () => {
  const nav = createNavigationController(routes())
  const r = nav.commit({ path: '/users?keyword=abc&tag=1&tag=2' })
  assert.deepEqual(r.location.query, { keyword: 'abc', tag: ['1', '2'] })
})

test('navigation：push 入栈、replace 不入栈、同页导航不重复入栈', () => {
  const nav = createNavigationController(routes())
  nav.commit({ tag: 'user-list' })
  assert.equal(nav.historySize, 1)
  assert.equal(nav.canGoBack, false)

  nav.commit({ tag: 'user-detail', params: { id: 1 } })
  assert.equal(nav.historySize, 2)
  assert.equal(nav.canGoBack, true)

  nav.commit({ tag: 'user-detail', params: { id: 1 } }) // 同页同参
  assert.equal(nav.historySize, 2)

  nav.commit({ tag: 'user-list', replace: true })
  assert.equal(nav.historySize, 2)
  assert.equal(nav.current.tag, 'user-list')
})

test('navigation：back / forward / go 与 canGoBack/canGoForward', () => {
  const nav = createNavigationController(routes())
  nav.commit({ tag: 'user-list' })
  nav.commit({ tag: 'user-detail', params: { id: 1 } })
  nav.commit({ tag: 'user-detail', params: { id: 2 } })

  assert.equal(nav.go(-1).ok, true)
  assert.equal(nav.current.params.id, 1)
  assert.equal(nav.canGoForward, true)

  assert.equal(nav.go(1).ok, true)
  assert.equal(nav.current.params.id, 2)
  assert.equal(nav.canGoForward, false)

  assert.equal(nav.go(-2).ok, true)
  assert.equal(nav.current.tag, 'user-list')
  assert.equal(nav.go(-1).ok, false)
  assert.equal(nav.go(0).reason, 'out-of-range')
})

test('navigation：前进历史在新 push 后被截断', () => {
  const nav = createNavigationController(routes())
  nav.commit({ tag: 'user-list' })
  nav.commit({ tag: 'user-detail', params: { id: 1 } })
  nav.go(-1)
  nav.commit({ tag: 'user-detail', params: { id: 5 } })
  assert.equal(nav.canGoForward, false)
  assert.equal(nav.historySize, 2)
})

test('navigation：guard 可中止，canNavigate 只判定不落地', () => {
  const nav = createNavigationController(routes())
  nav.commit({ tag: 'user-list' })
  const off = nav.beforeEach((to) => (to.tag === 'user-detail' ? false : undefined))

  const checked = nav.canNavigate({ tag: 'user-detail', params: { id: 1 } })
  assert.equal(checked.ok, false)
  assert.equal(checked.reason, 'aborted')

  assert.equal(nav.commit({ tag: 'user-detail', params: { id: 1 } }).ok, false)
  assert.equal(nav.current.tag, 'user-list', '被中止后 current 不变')

  off()
  assert.equal(nav.commit({ tag: 'user-detail', params: { id: 1 } }).ok, true)
})

test('navigation：canNavigate 不产生副作用（history 不变）', () => {
  const nav = createNavigationController(routes())
  nav.commit({ tag: 'user-list' })
  const size = nav.historySize
  nav.canNavigate({ tag: 'user-detail', params: { id: 1 } })
  assert.equal(nav.historySize, size)
})

test('navigation：未匹配 / 空目标', () => {
  const nav = createNavigationController(routes())
  assert.equal(nav.commit({ tag: 'nope-page' }).reason, 'not-found')
  assert.equal(nav.commit({}).reason, 'empty')
})

test('navigation：setRoutes 后当前路由消失 → 回落到有效历史并通知', () => {
  const nav = createNavigationController(routes())
  nav.commit({ tag: 'user-list' })
  nav.commit({ tag: 'user-detail', params: { id: 1 } })

  const seen = []
  nav.subscribe((location) => seen.push(location.tag))
  nav.setRoutes(routes().filter((r) => r.tag !== 'user-detail'))

  assert.deepEqual(seen, ['user-list'])
  assert.equal(nav.current.tag, 'user-list')
  assert.equal(nav.historySize, 1)
})

test('navigation：source 透传，默认 host', () => {
  const nav = createNavigationController(routes())
  assert.equal(nav.commit({ tag: 'user-list' }).location.source, 'host')
  assert.equal(nav.commit({ tag: 'user-list', source: 'agent' }).location.source, 'agent')
  nav.commit({ tag: 'user-detail', params: { id: 1 } })
  assert.equal(nav.go(-1, 'page').location.source, 'page')
})

test('navigation：history 上限 50', () => {
  const nav = createNavigationController(routes())
  for (let i = 0; i < 60; i += 1) nav.commit({ tag: 'user-detail', params: { id: i } })
  assert.equal(nav.historySize, 50)
})
