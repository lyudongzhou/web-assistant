import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../dist/runtime.js'
import { createFakeAdapter, createFakeImporter, fakeRoot, makeManifest } from './helpers.js'

/** 造一个带 RouterBridge 的假 adapter，模拟 vue-router 的 beforeEach/afterEach 两个回调 */
function adapterWithBridge(framework = 'vue') {
  const applied = []
  let api = null
  const fake = createFakeAdapter(framework, {
    createRouterBridge(bridgeApi) {
      api = bridgeApi
      return {
        apply(location, replace) {
          applied.push(`${location.tag}:${replace ? 'replace' : 'push'}`)
        },
        setRoutes(routes) {
          applied.push(`setRoutes:${routes.length}`)
        },
        dispose() {
          applied.push('dispose')
        },
      }
    },
  })
  return { ...fake, applied, getApi: () => api }
}

function makeRuntime(adapter) {
  const { importImpl } = createFakeImporter()
  return createRuntime({
    manifest: makeManifest({ containers: {} }),
    assetBase: '/wc',
    adapters: [adapter],
    importImpl,
  })
}

test('bridge：页面 router.push → core 落地并渲染，且不回推框架 router（防回环）', async () => {
  const { adapter, calls, handles, applied, getApi } = adapterWithBridge()
  const runtime = makeRuntime(adapter)
  await runtime.init(fakeRoot())
  // 初始导航（host 侧）应回推一次，让框架 router 与 core 对齐
  assert.deepEqual(applied, ['user-list:replace'])

  // 模拟页面里的 useRouter().push({ name, params })：
  // 1) beforeEach → canNavigate 判定
  const checked = getApi().canNavigate({ name: 'UserDetail', params: { id: 3 } })
  assert.equal(checked.ok, true)
  // 2) afterEach → commit 落地
  const result = await getApi().commit({ name: 'UserDetail', params: { id: 3 } })

  assert.equal(result.ok, true)
  assert.equal(runtime.current.route.tag, 'user-detail')
  assert.equal(runtime.current.location.source, 'page', 'source 标记为 page')
  assert.equal(handles[0].views.at(-1).props.id, 3, 'params 变成业务 WC 的 props')
  assert.ok(calls.includes('patch:vue:user-detail:ready'))
  assert.deepEqual(applied, ['user-list:replace'], '来自 bridge 的 commit 不再 apply 回去')
  runtime.dispose()
})

test('bridge：agent/host 导航会回推框架 router 一次', async () => {
  const { adapter, applied } = adapterWithBridge()
  const runtime = makeRuntime(adapter)
  await runtime.init(fakeRoot())
  await runtime.navigate({ tag: 'user-detail', params: { id: 1 }, source: 'agent', replace: true })
  await runtime.navigate({ tag: 'user-list', source: 'agent' })
  await runtime.back()
  assert.deepEqual(applied, [
    'user-list:replace',
    'user-detail:replace',
    'user-list:push',
    'user-detail:replace',
  ])
  runtime.dispose()
})

test('bridge：guard 中止时 canNavigate 返回 false，页面侧可感知（不落地）', async () => {
  const { adapter, getApi } = adapterWithBridge()
  const runtime = makeRuntime(adapter)
  await runtime.init(fakeRoot())
  runtime.beforeEach((to) => (to.tag === 'user-detail' ? false : undefined))
  assert.equal(getApi().canNavigate({ name: 'UserDetail', params: { id: 1 } }).ok, false)
  assert.equal((await getApi().commit({ name: 'UserDetail', params: { id: 1 } })).ok, false)
  assert.equal(runtime.current.route.tag, 'user-list')
  runtime.dispose()
})

test('bridge：setRoutes 同步给框架 router；dispose 释放桥', async () => {
  const { adapter, applied } = adapterWithBridge()
  const runtime = makeRuntime(adapter)
  await runtime.init(fakeRoot())
  await runtime.setRoutes([...runtime.routes])
  assert.ok(applied.includes('setRoutes:2'))
  runtime.dispose()
  assert.ok(applied.includes('dispose'))
})
