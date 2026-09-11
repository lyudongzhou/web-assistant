import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../dist/runtime.js'
import { createFakeAdapter, createFakeImporter, fakeRoot, makeManifest } from './helpers.js'

function setup(overrides = {}) {
  const { adapter, calls, handles } = createFakeAdapter('vue', overrides.adapter ?? {})
  const { importImpl, loads } = createFakeImporter(overrides.modules ?? {})
  const runtime = createRuntime({
    manifest: overrides.manifest ?? makeManifest({ containers: {} }),
    assetBase: '/wc',
    adapters: [adapter],
    importImpl,
    services: overrides.services ?? {},
    containerStrategy: overrides.containerStrategy,
    initial: overrides.initial,
    preload: overrides.preload,
    onError: overrides.onError,
  })
  return { runtime, adapter, calls, handles, loads }
}

test('runtime：init 顺序 —— 建容器 → 挂载 → 首帧渲染', async () => {
  const { runtime, calls } = setup()
  await runtime.init(fakeRoot())
  assert.deepEqual(calls.slice(0, 2), ['defineContainer:runtime-vue', 'mount:runtime-vue'])
  assert.equal(runtime.current.route.tag, 'user-list', '缺省导航到第一条路由')
  runtime.dispose()
})

test('runtime：未加载页面 → loading / ready 两帧，且 ready 帧带上页面样式', async () => {
  const { runtime, calls, handles } = setup()
  await runtime.init(fakeRoot())
  const views = handles[0].views
  assert.deepEqual(
    calls.filter((c) => c.startsWith('patch')),
    ['patch:vue:user-list:loading', 'patch:vue:user-list:ready'],
  )
  assert.deepEqual(views[0].styles, [], 'loading 帧还没有页面样式')
  assert.deepEqual(views[1].styles, ['/* /wc/pages/userList.js */'], 'ready 帧补上页面样式')
  assert.ok(views[1].stylesVersion > views[0].stylesVersion)
  assert.ok(calls.includes('definePage:user-list'))
  runtime.dispose()
})

test('runtime：已加载页面只出一帧（无多余 loading）', async () => {
  const { runtime, calls } = setup()
  await runtime.init(fakeRoot())
  await runtime.navigate({ tag: 'user-detail', params: { id: 1 } })
  const before = calls.length
  await runtime.navigate({ tag: 'user-list' })
  assert.deepEqual(calls.slice(before), ['patch:vue:user-list:ready'])
  runtime.dispose()
})

test('runtime：agent 按 tag 导航 + params → 归一后的 props 下发给业务 WC', async () => {
  const { runtime, handles } = setup()
  await runtime.init(fakeRoot())
  const user = { id: 7, name: 'x' }
  const result = await runtime.navigate({
    tag: 'user-detail',
    params: { id: '7' },
    props: { user },
    source: 'agent',
    replace: true,
  })
  assert.equal(result.ok, true)
  const view = handles[0].views.at(-1)
  assert.equal(view.tag, 'user-detail')
  assert.equal(view.props.id, '7')
  assert.equal(view.props.user, user, '对象保持引用（由 adapter 写成 property）')
  assert.equal(view.title, '用户详情')
  assert.equal(runtime.current.location.source, 'agent')
  runtime.dispose()
})

test('runtime：bundle 加载失败 → error 帧 + error 事件，且不影响后续导航', async () => {
  const errors = []
  const { runtime, handles } = setup({
    modules: {
      '/wc/pages/userDetail.js': () => {
        throw new Error('boom')
      },
    },
    onError: (e) => errors.push(e),
  })
  await runtime.init(fakeRoot())
  const result = await runtime.navigate({ tag: 'user-detail', params: { id: 1 } })
  assert.equal(result.ok, true, '路由已落地，只是资源加载失败')
  const view = handles[0].views.at(-1)
  assert.equal(view.status, 'error')
  assert.match(view.error.message, /user-detail.*加载失败/)
  assert.equal(errors.length, 1)

  await runtime.navigate({ tag: 'user-list' })
  assert.equal(handles[0].views.at(-1).status, 'ready')
  runtime.dispose()
})

test('runtime：容器加载失败 → 不落地导航', async () => {
  const errors = []
  const runtime = createRuntime({
    manifest: makeManifest(),
    assetBase: '/wc',
    importImpl: async (url) => {
      if (url.includes('containers/')) throw new Error('容器挂了')
      return { styles: [], definePage() {} }
    },
    onError: (e) => errors.push(e),
  })
  await runtime.init(fakeRoot())
  assert.equal(runtime.current, null, '没有任何页面落地')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /容器加载失败/)
  runtime.dispose()
})

test('runtime：back / forward / canGoBack', async () => {
  const { runtime } = setup()
  await runtime.init(fakeRoot())
  assert.equal(runtime.canGoBack, false)
  await runtime.navigate({ tag: 'user-detail', params: { id: 1 } })
  assert.equal(runtime.canGoBack, true)

  await runtime.back()
  assert.equal(runtime.current.route.tag, 'user-list')
  assert.equal(runtime.canGoForward, true)
  await runtime.forward()
  assert.equal(runtime.current.route.tag, 'user-detail')
  runtime.dispose()
})

test('runtime：preload=all 时首屏就把全部页面样式收齐', async () => {
  const { runtime, handles } = setup({ preload: 'all' })
  await runtime.init(fakeRoot())
  assert.deepEqual(handles[0].views.at(-1).styles, [
    '/* /wc/pages/userList.js */',
    '/* /wc/pages/userDetail.js */',
  ])
  runtime.dispose()
})

test('runtime：initial=null 时不导航，容器也不创建（完全懒建）', async () => {
  const { runtime, handles, calls } = setup({ initial: null })
  await runtime.init(fakeRoot())
  assert.equal(runtime.current, null)
  assert.deepEqual(calls, [], '没有任何容器/渲染动作')
  assert.equal(handles.length, 0)
  assert.equal(runtime.view.status, 'idle')
  assert.equal(runtime.view.tag, null)

  // 首次导航时才建容器
  await runtime.navigate({ tag: 'user-list' })
  assert.deepEqual(calls.slice(0, 2), ['defineContainer:runtime-vue', 'mount:runtime-vue'])
  runtime.dispose()
})

test('runtime：state / services 通道与事件', async () => {
  const { runtime, handles } = setup({ services: { state: { user: { id: 1 } } } })
  await runtime.init(fakeRoot())
  const stateEvents = []
  const serviceEvents = []
  runtime.on('state', (e) => stateEvents.push(e))
  runtime.on('services', (e) => serviceEvents.push(e))

  const servicesRef = handles[0].options.servicesRef
  runtime.setState({ user: { id: 2 } })
  runtime.setServices({ locale: 'en-US' })

  assert.deepEqual(stateEvents, [{ patch: { user: { id: 2 } }, keys: ['user'] }])
  assert.deepEqual(serviceEvents, [{ keys: ['locale'] }])
  assert.deepEqual(runtime.getState(), { user: { id: 2 } })
  assert.equal(servicesRef.state.user.id, 2, '容器拿到的是同一个稳定 state 引用')
  assert.equal(servicesRef.current.locale, 'en-US')
  runtime.dispose()
})

test('runtime：页面 emit → page-event 事件（供宿主转发给 agent）', async () => {
  const { runtime, handles } = setup()
  await runtime.init(fakeRoot())
  const seen = []
  runtime.on('page-event', (e) => seen.push(e))
  handles[0].options.onPageEvent({ tag: 'user-list', event: 'search', payload: { q: 'a' } })
  assert.deepEqual(seen, [{ tag: 'user-list', event: 'search', payload: { q: 'a' } }])
  runtime.dispose()
})

test('runtime：guard 中止导航（beforeEach）', async () => {
  const { runtime } = setup()
  await runtime.init(fakeRoot())
  runtime.beforeEach((to) => (to.tag === 'user-detail' ? false : undefined))
  const result = await runtime.navigate({ tag: 'user-detail', params: { id: 1 } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'aborted')
  assert.equal(runtime.current.route.tag, 'user-list')
  runtime.dispose()
})

test('runtime：未知 tag → not-found + error 事件', async () => {
  const errors = []
  const { runtime } = setup({ onError: (e) => errors.push(e) })
  await runtime.init(fakeRoot())
  const result = await runtime.navigate({ tag: 'nope-page' })
  assert.equal(result.reason, 'not-found')
  assert.equal(errors.length, 1)
  runtime.dispose()
})

test('runtime：dispose 卸载容器且后续操作抛错', async () => {
  const { runtime, calls } = setup()
  await runtime.init(fakeRoot())
  runtime.dispose()
  assert.ok(calls.includes('unmount:runtime-vue'))
  await assert.rejects(() => runtime.navigate({ tag: 'user-list' }), /已 dispose/)
  runtime.dispose() // 幂等
})

// ---------------- expose 桥：getPageExposed + page-exposed-changed ----------------

test('runtime：adapter 未实现 getPageExposed 时，返回 null（不抛错）', async () => {
  const { runtime } = setup()
  await runtime.init(fakeRoot())
  assert.equal(runtime.getPageExposed(), null)
  assert.equal(runtime.getPageExposed('user-list'), null)
  // 没实现时不应触发 page-exposed-changed
  const seen = []
  runtime.on('page-exposed-changed', (e) => seen.push(e))
  await runtime.navigate({ tag: 'user-detail', params: { id: 1 } })
  assert.deepEqual(seen, [])
  runtime.dispose()
})

test('runtime：adapter 实现 getPageExposed 时，settle 后广播 page-exposed-changed（仅函数字段）', async () => {
  const exposed = {
    refresh: () => 'r',
    setKeyword: (q) => q,
    /** 非函数：应被过滤 */
    meta: { v: 1 },
  }
  const { adapter, calls } = createFakeAdapter('vue', {
    getPageExposed(_handle, tag) {
      calls.push(`getPageExposed:${tag ?? 'current'}`)
      return tag ? exposed : exposed
    },
  })
  const { importImpl } = createFakeImporter()
  const runtime = createRuntime({
    manifest: makeManifest({ containers: {} }),
    assetBase: '/wc',
    adapters: [adapter],
    importImpl,
    services: {},
  })
  const seen = []
  runtime.on('page-exposed-changed', (e) => seen.push(e))

  await runtime.init(fakeRoot())
  // init 后第一次 settle（首屏 user-list）
  assert.deepEqual(seen[0], { tag: 'user-list', keys: ['refresh', 'setKeyword'] }, '过滤掉非函数字段')

  await runtime.navigate({ tag: 'user-detail', params: { id: 1 } })
  assert.deepEqual(seen.at(-1), { tag: 'user-detail', keys: ['refresh', 'setKeyword'] })

  // core.getPageExposed 透传 adapter 返回值
  assert.deepEqual(Object.keys(runtime.getPageExposed()), ['refresh', 'setKeyword'])
  assert.equal(runtime.getPageExposed('user-detail')['refresh'](), 'r')
  assert.equal(runtime.getPageExposed('user-list')['setKeyword']('x'), 'x')
  assert.equal(runtime.getPageExposed('not-rendered'), null, '未渲染 tag → null')
  runtime.dispose()
})

test('runtime：adapter 返回 null 时，keys 为空数组（仍广播，event 不漏）', async () => {
  const { adapter } = createFakeAdapter('vue', {
    getPageExposed: () => null,
  })
  const { importImpl } = createFakeImporter()
  const runtime = createRuntime({
    manifest: makeManifest({ containers: {} }),
    assetBase: '/wc',
    adapters: [adapter],
    importImpl,
    services: {},
  })
  const seen = []
  runtime.on('page-exposed-changed', (e) => seen.push(e))
  await runtime.init(fakeRoot())
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { tag: 'user-list', keys: [] })
  runtime.dispose()
})
