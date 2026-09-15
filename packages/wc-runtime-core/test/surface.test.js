// 内核 / 渲染面解耦的单测：
//   1. 假 surface 即可驱动内核（不加载 bundle、不建容器）—— 证明内核不含 WC 概念
//   2. 外部历史接管（host 模式）：委托 + 越界 + 「等回流提交」判定
//   3. manifest 宿主模式放宽（无 containers / 无 bundle / tag 无 '-' / framework 兜底）且容器模式仍严格
//   4. host 模式 adopt 宿主当前路由
//   5. expose 委托与「不支持时不广播」语义
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, normalizeManifest } from '../dist/index.js'

/** 宿主渲染面清单：三条路由，故意「无 tag / 无 framework / 无 bundle」 */
const hostManifest = {
  version: 2,
  pages: [
    { name: 'UserList', path: '/users', title: '用户列表' },
    { name: 'UserDetail', path: '/users/:id' },
    { name: 'Dashboard', path: '/dashboard' },
  ],
}

/**
 * 假宿主渲染面：记录 apply 调用；可注入 history / snapshot / createRouterBridge。
 * `setGo` 用来模拟「宿主的 go 触发了回流提交」。
 */
function fakeHostSurface(overrides = {}) {
  const applied = []
  const state = { canGoBack: false, canGoForward: false, goCalls: [] }
  let goImpl = null
  let expose = { refresh: () => 'r', setKeyword: (k) => k, meta: { v: 1 } }
  const host = {
    framework: 'vue',
    apply(view, ctx) {
      applied.push(`${view.tag}:${ctx.replace ? 'replace' : 'push'}:${ctx.source}`)
    },
    getPageExposed(target) {
      // 模拟真实实现：只有「当前挂载的页面」可读 expose（其余 tag → null）
      const current = applied.length ? applied.at(-1).split(':')[0] : null
      return target && target !== current ? null : expose
    },
    history: {
      get canGoBack() {
        return state.canGoBack
      },
      get canGoForward() {
        return state.canGoForward
      },
      go(delta) {
        state.goCalls.push(delta)
        return goImpl?.(delta)
      },
    },
    ...overrides,
  }
  return {
    host,
    applied,
    state,
    setGo: (fn) => {
      goImpl = fn
    },
    setExpose: (value) => {
      expose = value
    },
  }
}

function makeHostRuntime(host, extra = {}) {
  const loads = []
  const runtime = createRuntime({
    manifest: hostManifest,
    surface: 'host',
    hostSurface: host,
    initial: null,
    importImpl: async (url) => {
      loads.push(url)
      throw new Error('宿主模式不应加载任何 bundle')
    },
    ...extra,
  })
  return { runtime, loads }
}

test('surface：host 模式不加载 bundle、不建容器，导航直接落到宿主渲染面', async () => {
  const { host, applied } = fakeHostSurface()
  const { runtime, loads } = makeHostRuntime(host)

  await runtime.init() // ← 无挂载点（页面由宿主自己渲染）
  assert.deepEqual(loads, [], '没有任何 bundle 加载')

  const result = await runtime.navigate({ tag: 'user-list', source: 'agent', replace: true })
  assert.equal(result.ok, true)
  assert.deepEqual(applied, ['user-list:replace:agent'])
  assert.equal(runtime.hasPage, true)
  assert.equal(runtime.view.tag, 'user-list')
  assert.equal(runtime.view.framework, 'vue', 'framework 由渲染面兜底')
  assert.deepEqual(runtime.view.styles, [], '宿主模式不参与样式体系')
  assert.equal(runtime.view.stylesVersion, 0)
  runtime.dispose()
})

test('surface：surface=host 但缺 hostSurface → 创建即报错', () => {
  assert.throws(() => createRuntime({ manifest: hostManifest, surface: 'host' }), /hostSurface/)
})

test('surface：默认 surface=container（不传时行为不变）', async () => {
  const runtime = createRuntime({
    manifest: {
      version: 2,
      containers: { vue: { bundle: 'containers/vue.js' } },
      pages: [{ name: 'UserList', framework: 'vue', bundle: 'pages/userList.js' }],
    },
    adapters: [
      {
        framework: 'vue',
        defaultTagName: 'runtime-vue',
        defineContainer: () => ({}),
        mountContainer: () => undefined,
        patchContainer: () => undefined,
        unmountContainer: () => undefined,
        definePage: () => undefined,
      },
    ],
    importImpl: async () => ({ styles: [], definePage: () => undefined }),
    initial: null,
  })
  await runtime.init({ tagName: 'DIV' })
  assert.equal(runtime.view.tag, null)
  runtime.dispose()
})

test('surface：外部历史接管 —— go 委托宿主；无提交（越界）→ out-of-range 不悬挂', async () => {
  const { host, state } = fakeHostSurface()
  const { runtime } = makeHostRuntime(host)
  await runtime.init()
  assert.equal(runtime.canGoBack, false, '宿主历史说了算')

  const back = await runtime.back()
  assert.equal(back.ok, false)
  assert.equal(back.reason, 'out-of-range')
  assert.deepEqual(state.goCalls, [-1], '委托给宿主 history.go(-1)')
  runtime.dispose()
})

test('surface：宿主 go 触发回流提交 → 判定成功并更新当前页', async () => {
  let api = null
  const { host, state, setGo } = fakeHostSurface({
    createRouterBridge(bridgeApi) {
      api = bridgeApi
      return { apply: () => undefined, setRoutes: () => undefined, dispose: () => undefined }
    },
  })
  const { runtime } = makeHostRuntime(host)
  await runtime.init()
  await runtime.navigate({ tag: 'user-list', replace: true })
  assert.ok(api, '桥由宿主渲染面建立（真实 router 的回流部分）')

  // 模拟「宿主的 go 内部完成了一次导航 → afterEach → commit 回流内核」
  setGo(() => api.commit({ name: 'UserDetail', params: { id: '2' }, source: 'host' }))
  const result = await runtime.back()
  assert.equal(result.ok, true)
  assert.equal(runtime.current.route.tag, 'user-detail')
  assert.equal(runtime.current.location.source, 'host')
  assert.equal(runtime.view.props.id, '2', 'params 仍按 manifest 归一成 props')
  assert.deepEqual(state.goCalls, [-1])
  runtime.dispose()
})

test('surface：go(0) 直接判越界（不做无意义委托）', async () => {
  const { host, state } = fakeHostSurface()
  const { runtime } = makeHostRuntime(host)
  await runtime.init()
  const result = await runtime.go(0)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'out-of-range')
  assert.deepEqual(state.goCalls, [])
  runtime.dispose()
})

test('surface：host 模式 init 时 adopt 宿主当前路由', async () => {
  const { host, applied } = fakeHostSurface({
    snapshot: () => ({ name: 'UserList', path: '/users' }),
  })
  const { runtime } = makeHostRuntime(host)
  await runtime.init()
  assert.equal(runtime.current.route.tag, 'user-list')
  assert.equal(runtime.current.location.source, 'initial')
  assert.equal(runtime.hasPage, true)
  assert.deepEqual(applied, ['user-list:replace:initial'])
  runtime.dispose()
})

test('surface：adopt=false 时不纳入宿主当前路由（从空态开始）', async () => {
  const { host, applied } = fakeHostSurface({ snapshot: () => ({ name: 'UserList' }) })
  const { runtime } = makeHostRuntime(host, { adopt: false })
  await runtime.init()
  assert.equal(runtime.current, null)
  assert.equal(runtime.hasPage, false)
  assert.deepEqual(applied, [])
  runtime.dispose()
})

test('surface：host expose 委托（仅函数字段）与「不支持时不广播」', async () => {
  const { host } = fakeHostSurface()
  const { runtime } = makeHostRuntime(host)
  const seen = []
  runtime.on('page-exposed-changed', (event) => seen.push(event))
  await runtime.init()
  assert.deepEqual(seen, [], '没有导航就没有页面 expose 事件')

  await runtime.navigate({ tag: 'user-list', replace: true })
  assert.deepEqual(seen, [{ tag: 'user-list', keys: ['refresh', 'setKeyword'] }], '过滤非函数字段')
  assert.equal(runtime.getPageExposed('user-list').refresh(), 'r')
  assert.equal(runtime.getPageExposed('user-detail'), null, '非当前页 → null')
  runtime.dispose()

  // 宿主未实现 getPageExposed → 不广播（与容器 adapter 未实现时的语义一致）
  const plain = fakeHostSurface({ getPageExposed: undefined })
  const { runtime: rt2 } = makeHostRuntime(plain.host)
  const seen2 = []
  rt2.on('page-exposed-changed', (event) => seen2.push(event))
  await rt2.init()
  await rt2.navigate({ tag: 'user-list', replace: true })
  assert.deepEqual(seen2, [], '渲染面不支持 expose → 内核不广播')
  assert.equal(rt2.getPageExposed(), null)
  rt2.dispose()
})

test('surface：framework 与渲染面不符 → 结构化失败（不静默）', async () => {
  const { host } = fakeHostSurface()
  const { runtime } = makeHostRuntime(host)
  const errors = []
  runtime.on('error', (event) => errors.push(event))
  await runtime.init()

  // 直接喂一条 react 路由：宿主渲染面只服务 vue → ensure 抛错 → 不落地
  await runtime.setRoutes([
    {
      tag: 'chart',
      name: 'Chart',
      path: '/chart',
      framework: 'react',
      bundle: '',
      params: [],
      props: [],
      events: [],
      meta: {},
    },
  ])
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /只服务 framework=vue/)
  runtime.dispose()
})

test('surface：渲染面在 commit 前拦下不可渲染的页（canRender）→ not-found 且状态不推进', async () => {
  const { host } = fakeHostSurface({
    canRender: (route) => (route.tag === 'user-detail' ? '宿主 router 未注册该路由（示例）' : null),
  })
  const { runtime } = makeHostRuntime(host)
  await runtime.init()
  await runtime.navigate({ tag: 'user-list', replace: true })

  const errors = []
  runtime.on('error', (event) => errors.push(event))
  const denied = await runtime.navigate({ tag: 'user-detail', params: { id: '1' }, replace: true })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'not-found')
  assert.match(denied.detail, /未注册该路由/)
  assert.equal(runtime.current.route.tag, 'user-list', '内核状态没有被推进')
  assert.equal(runtime.view.tag, 'user-list')
  assert.equal(errors.length, 1, '错误经 error 事件透出')
  runtime.dispose()
})

test('manifest：宿主模式放宽 —— 无 containers / 无 bundle / tag 无 - / framework 兜底', () => {
  const manifest = normalizeManifest(
    { version: 2, pages: [{ name: 'Dashboard', path: '/dashboard' }] },
    { forHostSurface: true, preRegisteredFrameworks: ['vue'], defaultFramework: 'vue' },
  )
  assert.equal(manifest.routes[0].tag, 'dashboard', '无 "-" 也合法（不再是自定义元素标签）')
  assert.equal(manifest.routes[0].framework, 'vue')
  assert.equal(manifest.routes[0].bundle, '')
  assert.deepEqual(manifest.containers, [])
  assert.deepEqual(manifest.sharedStyles, [])
})

test('manifest：容器模式仍严格（缺 bundle / tag 无 "-" 均报错）', () => {
  assert.throws(
    () =>
      normalizeManifest(
        { version: 2, pages: [{ name: 'Dashboard', path: '/dashboard' }] },
        { preRegisteredFrameworks: ['vue'], defaultFramework: 'vue' },
      ),
    /缺少 bundle/,
  )
  assert.throws(
    () =>
      normalizeManifest(
        {
          version: 2,
          pages: [{ name: 'Dashboard', path: '/dashboard', bundle: 'pages/dashboard.js' }],
        },
        { preRegisteredFrameworks: ['vue'], defaultFramework: 'vue' },
      ),
    /必须包含/,
  )
})
