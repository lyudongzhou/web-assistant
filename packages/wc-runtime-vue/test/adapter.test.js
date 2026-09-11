// runtime-vue 冒烟测试：不引入 jsdom，只给最小 DOM 桩。
// 目的不是验证渲染，而是验证「契约接线」：vue-router 桥的三个机制、patchContainer 的属性写入、context 注入。
// 真正的渲染/样式行为留给 demo 端到端验证（Phase 3）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

function fakeElement(tagName) {
  return {
    tagName,
    style: { setProperty() {} },
    children: [],
    shadowRoot: null,
    attrs: {},
    textContent: '',
    appendChild(child) {
      this.children.push(child)
    },
    remove() {},
    setAttribute(name, value) {
      this.attrs[name] = value
    },
  }
}

const defined = new Map()

// 注意顺序：vue-router 在模块初始化时用 `typeof document !== 'undefined'` 判定 isBrowser，
// 一旦提前塞了 document 桩，它会以为在浏览器里去摸 window/history。
// 所以先 import 依赖 vue-router 的模块（走 memory/SSR 分支），之后再装 DOM 桩给容器用。
const { normalizeManifest, createServicesRef, activityBus, withActivityOrigin, isActivityTraced } =
  await import('@webassistant/wc-runtime-core')
const { createVueRouter, createVueRouterBridge, toRouteRecords } = await import(
  '../dist/vueRouterBridge.js'
)
const { shallowReactive } = await import('vue')

globalThis.customElements = {
  get: (tag) => defined.get(tag),
  define: (tag, ctor) => defined.set(tag, ctor),
}
globalThis.document = {
  createElement: (tag) => fakeElement(tag),
  head: fakeElement('head'),
  querySelector: () => null,
}

const { defineVueContainer } = await import('../dist/container.js')
const { createRuntimeContext } = await import('../dist/context.js')

const routes = normalizeManifest(
  {
    version: 2,
    pages: [
      { name: 'UserList', tag: 'user-list', path: '/users', framework: 'vue', bundle: 'a.js' },
      {
        name: 'UserDetail',
        tag: 'user-detail',
        path: '/users/:id',
        framework: 'vue',
        bundle: 'b.js',
      },
    ],
  },
  { preRegisteredFrameworks: ['vue'] },
).routes

function makeBridge(canNavigate = () => ({ ok: true })) {
  const commits = []
  const router = createVueRouter()
  const bridge = createVueRouterBridge(router, {
    routes,
    canNavigate,
    commit: async (target) => {
      commits.push(target)
      return { ok: true }
    },
  })
  return { router, bridge, commits }
}

test('vue bridge：路由表同步为哑组件记录（渲染由容器负责，不走 router-view）', () => {
  const records = toRouteRecords(routes)
  assert.equal(records.length, 2)
  assert.equal(records[1].path, '/users/:id')
  assert.equal(records[1].meta.tag, 'user-detail')
  assert.equal(records[1].component.render(), null)

  const { router } = makeBridge()
  assert.equal(router.hasRoute('UserList'), true)
  assert.equal(router.hasRoute('UserDetail'), true)
})

test('vue bridge：页面 router.push → commit 到 core（source=page）', async () => {
  const { router, commits } = makeBridge()
  await router.push({ name: 'UserDetail', params: { id: '3' } })
  assert.equal(commits.length, 1)
  assert.equal(commits[0].name, 'UserDetail')
  assert.equal(commits[0].params.id, '3')
  assert.equal(commits[0].source, 'page')
})

test('vue bridge：core 推过来的导航不会再 commit 回去（防回环）', async () => {
  const { bridge, commits, router } = makeBridge()
  await bridge.apply(
    { tag: 'user-detail', name: 'UserDetail', path: '/users/3', params: { id: '3' }, query: {}, props: {}, source: 'agent' },
    true,
  )
  assert.equal(router.currentRoute.value.name, 'UserDetail', 'vue-router 已与 core 对齐')
  assert.deepEqual(commits, [], '没有产生回环 commit')

  // 回环防护是计数器而非布尔：apply 之后页面自己的 push 仍能正常 commit
  await router.push({ name: 'UserList' })
  assert.equal(commits.length, 1)
})

test('vue bridge：并发 apply 后仍不漏掉页面导航（计数器语义）', async () => {
  const { bridge, commits, router } = makeBridge()
  const loc = (name, path) => ({ tag: name, name, path, params: {}, query: {}, props: {}, source: 'agent' })
  await Promise.all([
    bridge.apply(loc('UserList', '/users'), true),
    bridge.apply(loc('UserList', '/users'), true),
  ])
  assert.deepEqual(commits, [])
  await router.push({ name: 'UserDetail', params: { id: '9' } })
  assert.equal(commits.length, 1)
})

test('vue bridge：guard 前移 —— core 拒绝时 vue-router 导航被中止，页面可感知', async () => {
  const { router, commits } = makeBridge((target) =>
    target.name === 'UserDetail' ? { ok: false, reason: 'aborted' } : { ok: true },
  )
  await router.push({ name: 'UserList' })
  const failure = await router.push({ name: 'UserDetail', params: { id: '1' } })
  assert.ok(failure, 'push 返回 NavigationFailure')
  assert.equal(router.currentRoute.value.name, 'UserList')
  assert.equal(commits.length, 1, '被拒绝的导航没有 commit')
})

test('vue bridge：setRoutes 增删同步到 vue-router；dispose 摘掉守卫', async () => {
  const { router, bridge, commits } = makeBridge()
  bridge.setRoutes([routes[0]])
  assert.equal(router.hasRoute('UserDetail'), false)
  bridge.setRoutes(routes)
  assert.equal(router.hasRoute('UserDetail'), true)

  bridge.dispose()
  await router.push({ name: 'UserList' })
  assert.deepEqual(commits, [], 'dispose 后不再 commit')
})

test('vue adapter：patchContainer 把 view 写成元素 property（对象保持引用）', () => {
  const adapter = defineVueContainer({ tagName: 'runtime-vue-test' })
  const handle = { element: fakeElement('runtime-vue-test'), tagName: 'runtime-vue-test' }
  const user = { id: 7 }
  adapter.patchContainer(handle, {
    framework: 'vue',
    tag: 'user-detail',
    props: { id: '7', user },
    styles: ['.a{}'],
    stylesVersion: 3,
    status: 'ready',
    events: ['save'],
  })
  const el = handle.element
  assert.equal(el.tag, 'user-detail')
  assert.equal(el.pageProps.user, user, '对象走 property，引用不变')
  assert.deepEqual(el.pageStyles, ['.a{}'])
  assert.equal(el.stylesVersion, 3)
  assert.equal(el.status, 'ready')
  assert.deepEqual(el.events, ['save'])
  assert.equal(el.error, null)
})

test('vue adapter：patchContainer 把页面样式也注入光 DOM（内容哈希去重）', () => {
  const adapter = defineVueContainer({ tagName: 'runtime-vue-test' })
  const handle = { element: fakeElement('runtime-vue-test'), tagName: 'runtime-vue-test' }
  const head = globalThis.document.head
  const before = head.children.length

  adapter.patchContainer(handle, {
    framework: 'vue',
    tag: 'user-list',
    props: {},
    styles: ['.wa-a{color:red}'],
    stylesVersion: 1,
    status: 'ready',
    events: [],
  })

  assert.equal(head.children.length, before + 1, '页面样式补一份进光 DOM')
  const injected = head.children[head.children.length - 1]
  assert.equal(injected.textContent, '.wa-a{color:red}')
  assert.ok(injected.attrs['data-wa-light'].startsWith('wa-page-'), 'key = prefix + 内容哈希')

  // 再次 patch 相同样式：内容去重，不再追加
  adapter.patchContainer(handle, {
    framework: 'vue',
    tag: 'user-list',
    props: {},
    styles: ['.wa-a{color:red}'],
    stylesVersion: 1,
    status: 'ready',
    events: [],
  })
  assert.equal(head.children.length, before + 1, '相同内容不再重复注入')
})

test('vue adapter：defineContainer 注册自定义元素（幂等）并返回元素句柄', () => {
  const adapter = defineVueContainer()
  const servicesRef = createServicesRef({ theme: { '--x': '1px' } })
  const nav = { current: () => null, canGoBack: false, canGoForward: false }
  const define = { tagName: 'runtime-vue-a', servicesRef, navigation: nav, onPageEvent() {} }

  const first = adapter.defineContainer(define)
  assert.equal(first.tagName, 'runtime-vue-a')
  assert.equal(first.element.tagName, 'runtime-vue-a')
  assert.ok(defined.has('runtime-vue-a'))

  const before = defined.get('runtime-vue-a')
  adapter.defineContainer(define)
  assert.equal(defined.get('runtime-vue-a'), before, '重复 defineContainer 不重复注册')

  const root = fakeElement('div')
  adapter.mountContainer(first, root)
  assert.equal(root.children.length, 1)
})

test('vue adapter：definePage 缺少约定导出时报错', () => {
  const adapter = defineVueContainer()
  assert.throws(
    () => adapter.definePage({}, { tag: 'x-a', route: { bundle: 'x.js' } }),
    /需导出 definePage/,
  )
})

test('vue adapter：framework 与默认容器标签', () => {
  assert.equal(defineVueContainer().framework, 'vue')
  assert.equal(defineVueContainer().defaultTagName, 'runtime-vue')
  assert.equal(defineVueContainer({ tagName: 'my-host' }).defaultTagName, 'my-host')
})

test('vue adapter：不同容器实例抢注同一 tagName 时显式告警（自定义元素不可注销）', () => {
  const servicesRef = createServicesRef({})
  const nav = { current: () => null, canGoBack: false, canGoForward: false }
  const define = { tagName: 'runtime-vue-dup', servicesRef, navigation: nav }

  defineVueContainer().defineContainer(define)
  const original = console.warn
  const warns = []
  console.warn = (msg) => warns.push(String(msg))
  try {
    defineVueContainer().defineContainer(define) // 另一个实例抢同名
  } finally {
    console.warn = original
  }
  assert.equal(warns.length, 1)
  assert.match(warns[0], /已被另一个容器实例注册/)
})

test('vue adapter：getPageExposed 兼容 Vue3.5（_instance.exposed）与旧约定（element.exposed）', () => {
  const adapter = defineVueContainer()
  const servicesRef = createServicesRef({})
  const nav = { current: () => null, canGoBack: false, canGoForward: false }
  const define = { tagName: 'runtime-vue-exp', servicesRef, navigation: nav, onPageEvent() {} }
  const handle = adapter.defineContainer(define)
  handle.element.tag = 'user-list'

  const refresh = () => 1

  // Vue 3.5.41 实测形态：defineExpose 的原始对象在组件实例 element._instance.exposed 上，
  // 元素自身没有 .exposed 属性（defineExpose 成员被拷成元素自身 property）
  handle.currentPageElement = Object.assign(fakeElement('user-list'), {
    _instance: { exposed: { refresh } },
  })
  const fromInstance = adapter.getPageExposed(handle)
  assert.deepEqual(Object.keys(fromInstance), ['refresh'])
  assert.equal(fromInstance.refresh(), 1, '包裹后仍可调用且返回值不变')

  // 旧约定：直接伪造 element.exposed 也继续可用（向后兼容）
  handle.currentPageElement = Object.assign(fakeElement('user-list'), { exposed: { refresh } })
  assert.deepEqual(Object.keys(adapter.getPageExposed(handle)), ['refresh'])

  // 两者皆无（页面没写 defineExpose / 旧版 Vue）→ null
  handle.currentPageElement = fakeElement('user-list')
  assert.equal(adapter.getPageExposed(handle), null)

  // 指定 tag（非当前页）：从 shadowRoot 按 tag 查
  const detail = Object.assign(fakeElement('user-detail'), { _instance: { exposed: { save() {} } } })
  handle.element.shadowRoot = { querySelector: (t) => (t === 'user-detail' ? detail : null) }
  const byTag = adapter.getPageExposed(handle, 'user-detail')
  assert.deepEqual(Object.keys(byTag), ['save'])
  // 查不到的 tag → null
  assert.equal(adapter.getPageExposed(handle, 'nope'), null)
})

test('vue adapter：expose 调用被 activityBus 记账（方法名/参数/耗时/结果/错误/origin）', async () => {
  const adapter = defineVueContainer()
  const servicesRef = createServicesRef({})
  const nav = { current: () => null, canGoBack: false, canGoForward: false }
  const define = { tagName: 'runtime-vue-trace', servicesRef, navigation: nav, onPageEvent() {} }
  const handle = adapter.defineContainer(define)
  handle.element.tag = 'user-list'

  const save = async (data) => ({ saved: data })
  const boom = () => {
    throw new Error('保存失败')
  }
  handle.currentPageElement = Object.assign(fakeElement('user-list'), {
    _instance: { exposed: { save, boom, meta: { v: 1 } } },
  })

  activityBus.clear()
  const seen = []
  const off = activityBus.on((a) => seen.push(a))
  try {
    const exposed = adapter.getPageExposed(handle)
    // 非函数字段原样透传、不打标
    assert.deepEqual(exposed.meta, { v: 1 })
    assert.equal(isActivityTraced(exposed.meta), false, '非函数不打标')

    // agent 来源：withActivityOrigin 标记应落到记录上
    const value = await withActivityOrigin('agent', () => exposed.save({ name: '主库' }))
    assert.deepEqual(value, { saved: { name: '主库' } })

    const sync = exposed.save // 同步方法（未 await 的 Promise 也要记）
    await sync({ name: '备库' })

    // host 来源（默认）
    assert.throws(() => exposed.boom(), /保存失败/)

    const calls = seen.filter((a) => a.kind === 'call')
    assert.equal(calls.length, 3, '两次 save + 一次 boom')

    const [firstSave, secondSave, failed] = calls
    assert.deepEqual(
      { tag: firstSave.tag, name: firstSave.name, args: firstSave.args, origin: firstSave.origin, ok: firstSave.ok },
      { tag: 'user-list', name: 'save', args: [{ name: '主库' }], origin: 'agent', ok: true },
    )
    assert.deepEqual(firstSave.result, { saved: { name: '主库' } })
    assert.equal(typeof firstSave.durationMs, 'number')

    assert.equal(secondSave.origin, 'host', '没标 origin 时缺省 host')
    assert.equal(failed.ok, false)
    assert.equal(failed.error, '保存失败')
    assert.equal(failed.name, 'boom')

    assert.equal(isActivityTraced(exposed.save), true, '包裹过的函数带标记（宿主据此不重复记账）')
  } finally {
    off()
    activityBus.clear()
  }
})

test('vue context：t 兜底、request/emit 透传、state 浅响应同步', () => {
  const emitted = []
  const servicesRef = createServicesRef({
    request: { get: () => 'x' },
    emit: (event, payload) => emitted.push([event, payload]),
    state: { user: { id: 1 } },
  })
  const state = shallowReactive({ ...servicesRef.state })
  servicesRef.subscribe((ref, change) => {
    if (change.kind !== 'state') return
    for (const key of change.keys) state[key] = ref.state[key]
  })
  const nav = { current: () => null, canGoBack: false, canGoForward: false }
  const context = createRuntimeContext(servicesRef, nav, state)

  assert.equal(context.t('未翻译'), '未翻译', '没有 t 时原样返回 key')
  servicesRef.set({ t: (key) => `zh:${key}` })
  assert.equal(context.t('hello'), 'zh:hello', 'services 换了之后 context 自动跟上')

  context.emit('search', { q: 'a' })
  assert.deepEqual(emitted, [['search', { q: 'a' }]])
  assert.equal(context.request, servicesRef.current.request)

  servicesRef.setState({ user: { id: 2 } })
  assert.deepEqual(state.user, { id: 2 }, 'setState 同步进容器的响应式副本')
})

