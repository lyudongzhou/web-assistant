// 宿主直连渲染面（用法 B）冒烟测试：
// 用 memory router 冒充「宿主的真实 vue-router」—— 不起 DOM、不挂 app，只验证契约接线：
//   1. agent 导航落到真实 router，且**不 addRoute**（宿主路由表是真相）
//   2. 宿主导航回流内核（source: 'host'），core 守卫前移能中止宿主导航
//   3. 同路由不重复 push；页面目录与真实路由一致性校验
//   4. 直传 props 的旁路（pageProps）与 expose 读取（无实例时返回 null）
//   5. 当前路由不在页面目录内时不 adopt
//
// 真实验收（页面渲染、defineExpose 调用、数据回传）在 demo-app 的 host 模式验收台。
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 注意顺序（同 adapter.test.js）：先在无 DOM 桩的环境里加载 vue-router，
// 否则它会把 node 当成浏览器去摸 window / history。
const { createRouter, createMemoryHistory } = await import('vue-router')
const { createRuntime } = await import('@webassistant/wc-runtime-core')
const { createVueHostSurface } = await import('../dist/hostSurface.js')

/** 宿主页面目录（host 模式：无 bundle / 无 containers / name 必须等于 route name） */
const manifestInput = {
  version: 2,
  pages: [
    { name: 'UserList', path: '/users', title: '用户列表' },
    { name: 'UserDetail', path: '/users/:id', title: '用户详情' },
  ],
}

const page = { render: () => null }

function makeHostRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'Login', component: page },
      { path: '/users', name: 'UserList', component: page },
      { path: '/users/:id', name: 'UserDetail', component: page },
    ],
  })
}

function makeHostRuntime(router, extra = {}) {
  return createRuntime({
    manifest: manifestInput,
    surface: 'host',
    hostSurface: createVueHostSurface({ router }),
    ...extra,
  })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test('hostSurface：agent 导航落到真实 router，且不向宿主路由表 addRoute', async () => {
  const router = makeHostRouter()
  await router.push('/users')
  const routeCountBefore = router.getRoutes().length

  const runtime = makeHostRuntime(router)
  await runtime.init()
  // adopt：宿主已在 /users（在页面目录内）→ 直接成为内核当前页
  assert.equal(runtime.current.route.tag, 'user-list')
  assert.equal(runtime.current.location.source, 'initial')
  assert.equal(router.getRoutes().length, routeCountBefore, '绝不 addRoute（未污染宿主路由表）')

  const result = await runtime.navigate({
    tag: 'user-detail',
    params: { id: '7' },
    source: 'agent',
    replace: true,
  })
  assert.equal(result.ok, true)
  assert.equal(String(router.currentRoute.value.name), 'UserDetail', '导航真的作用在宿主 router 上')
  assert.equal(String(router.currentRoute.value.params.id), '7')
  assert.equal(runtime.current.route.tag, 'user-detail')
  runtime.dispose()
})

test('hostSurface：宿主导航（router.push）回流内核，source 标记 host', async () => {
  const router = makeHostRouter()
  await router.push('/users')
  const runtime = makeHostRuntime(router)
  const seen = []
  runtime.on('navigate', (event) => seen.push(`${event.route.tag}:${event.source}`))
  await runtime.init()
  seen.length = 0

  await router.push({ name: 'UserDetail', params: { id: '3' } })
  await tick()
  assert.deepEqual(seen, ['user-detail:host'], '用户操作路由 → 回流内核')
  assert.equal(runtime.current.route.tag, 'user-detail')
  runtime.dispose()
})

test('hostSurface：core 守卫前移 —— 宿主导航被拒时 URL 不变', async () => {
  const router = makeHostRouter()
  await router.push('/users')
  const runtime = makeHostRuntime(router)
  await runtime.init()
  runtime.beforeEach((to) => (to.tag === 'user-detail' ? false : undefined))

  // vue-router 对「被 beforeEach 返回 false 中止」的导航以 NavigationFailure 结算（不 reject）
  await router.push({ name: 'UserDetail', params: { id: '1' } }).catch(() => undefined)
  assert.equal(String(router.currentRoute.value.name), 'UserList', '宿主导航被 core 守卫中止')
  assert.equal(runtime.current.route.tag, 'user-list')
  runtime.dispose()
})

test('hostSurface：已是当前路由时不重复 push', async () => {
  const router = makeHostRouter()
  await router.push('/users')
  const runtime = makeHostRuntime(router)
  await runtime.init()

  const pushes = []
  const originalPush = router.push.bind(router)
  router.push = (...args) => {
    pushes.push(args[0])
    return originalPush(...args)
  }

  const result = await runtime.navigate({ tag: 'user-list', replace: true })
  assert.equal(result.ok, true)
  assert.deepEqual(pushes, [], '同一路由不产生多余导航（首屏 adopt 也走这条路）')
  assert.equal(runtime.current.route.tag, 'user-list')
  runtime.dispose()
})

test('hostSurface：页面目录里的路由此刻未注册（登录/权限）→ warn + 导航给结构化失败', async () => {
  const router = makeHostRouter()
  await router.push('/users')
  const warn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(String(args[0]))
  try {
    const runtime = createRuntime({
      manifest: {
        version: 2,
        pages: [
          { name: 'UserList', path: '/users' },
          { name: 'UserDetail', path: '/users/:id' },
          // 这两条在宿主 router 里不存在（真实项目里 = 尚未登录 / 无权限）
          { name: 'NotThere', path: '/nope' },
          { name: 'AlsoMissing', path: '/nope2' },
        ],
      },
      surface: 'host',
      hostSurface: createVueHostSurface({ router }),
    })
    // init 不因缺失路由而失败（否则登录页上助手直接不可用）
    await runtime.init()
    assert.equal(runtime.current.route.tag, 'user-list', '已注册的路由照常 adopt')
    assert.ok(
      warnings.some((line) => line.includes('NotThere') && line.includes('AlsoMissing')),
      '缺失的路由一次性报出来',
    )

    // 导航到未注册的路由 → 结构化失败，且内核状态不被推进
    const denied = await runtime.navigate({ tag: 'not-there', replace: true })
    assert.equal(denied.ok, false)
    assert.equal(denied.reason, 'not-found')
    assert.match(denied.detail, /未注册路由「NotThere」/)
    assert.equal(runtime.current.route.tag, 'user-list', '状态没有分裂')
    assert.equal(String(router.currentRoute.value.name), 'UserList', '宿主 URL 也没动')

    // 已注册的路由照常可导航
    const ok = await runtime.navigate({ tag: 'user-detail', params: { id: '2' }, replace: true })
    assert.equal(ok.ok, true)
    assert.equal(String(router.currentRoute.value.name), 'UserDetail')
    runtime.dispose()
  } finally {
    console.warn = warn
  }
})

test('hostSurface：直传 props 走旁路 pageProps（对象保持引用；passProps:false 关闭）', async () => {
  const router = makeHostRouter()
  await router.push('/users')
  const hostSurface = createVueHostSurface({ router })
  const runtime = createRuntime({ manifest: manifestInput, surface: 'host', hostSurface })
  await runtime.init()

  const filter = { status: 'paid' }
  await runtime.navigate({
    tag: 'user-detail',
    params: { id: '9' },
    props: { filter },
    replace: true,
  })
  assert.equal(hostSurface.pageProps.id, '9', 'params 归一进旁路')
  assert.equal(hostSurface.pageProps.filter, filter, '对象保持引用（真实 router 承载不了它）')
  runtime.dispose()

  // passProps: false → 旁路恒空
  const router2 = makeHostRouter()
  await router2.push('/users')
  const plain = createVueHostSurface({ router: router2, passProps: false })
  const runtime2 = createRuntime({ manifest: manifestInput, surface: 'host', hostSurface: plain })
  await runtime2.init()
  await runtime2.navigate({ tag: 'user-detail', params: { id: '9' }, replace: true })
  assert.deepEqual({ ...plain.pageProps }, {})
  runtime2.dispose()
})

test('hostSurface：无挂载实例时 expose 为空（广播空 keys，不抛错）', async () => {
  const router = makeHostRouter()
  await router.push('/users')
  const runtime = makeHostRuntime(router)
  const seen = []
  runtime.on('page-exposed-changed', (event) => seen.push(event))
  await runtime.init()
  assert.deepEqual(seen, [{ tag: 'user-list', keys: [] }], '未挂载 app → 空能力清单仍广播')
  assert.equal(runtime.getPageExposed(), null)
  assert.equal(runtime.getPageExposed('user-list'), null)
  runtime.dispose()
})

test('hostSurface：当前路由不在页面目录内（登录页）→ 不 adopt，从空态开始', async () => {
  const router = makeHostRouter()
  await router.push('/login')
  const runtime = makeHostRuntime(router)
  await runtime.init()
  assert.equal(runtime.current, null)
  assert.equal(runtime.hasPage, false)
  runtime.dispose()
})

test('hostSurface：history 委托宿主（node 无 window → 不可回退）', async () => {
  const router = makeHostRouter()
  await router.push('/users')
  const runtime = makeHostRuntime(router)
  await runtime.init()
  assert.equal(runtime.canGoBack, false, '宿主真实历史说了算（此处无 window）')
  assert.equal(runtime.canGoForward, false)
  runtime.dispose()
})
