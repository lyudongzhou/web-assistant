// 宿主 store → CE 快照桥（storeBridge）测试。
// 不依赖真实 pinia / DOM：只用「pinia store 的公开面」写最小 fake，
// 验证接线契约 —— 谁在什么时候推、推的是不是新对象、hydrate 会不会共享引用、dispose 是否解绑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextTick, shallowReactive } from 'vue'

const {
  HOST_STORE_KEY_PREFIX,
  STORE_PATCH_EVENT,
  applyHostStorePatch,
  cloneHostState,
  createHostStorePusher,
  hostStoreIdFromKey,
  hostStoreKey,
  isHostStoreKey,
} = await import('../dist/hostStore.js')
const { createStoreMirror } = await import('../dist/storeMirror.js')

/** 最小 store fake：只实现 $id / $state / $patch / $subscribe / $dispose（都是 pinia 公开 API） */
function fakeStore(id, state = {}) {
  const listeners = new Set()
  const store = {
    $id: id,
    $state: { ...state },
    patches: [],
    $patch(partial) {
      store.patches.push(partial)
      Object.assign(store.$state, partial)
    },
    $subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    $dispose() {
      store.disposed = true
    },
    // —— 测试辅助 ——
    touch() {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
  return store
}

/** 最小 pinia fake：use() 注册插件，installTo() 模拟「store 创建时逐个跑插件」 */
function fakePinia() {
  const plugins = []
  return {
    use(plugin) {
      plugins.push(plugin)
      return this
    },
    installTo(store) {
      for (const plugin of plugins) plugin({ store, pinia: this, app: null })
      return store
    },
  }
}

function fakeRuntime() {
  return {
    patches: [],
    setState(patch) {
      this.patches.push(patch)
    },
  }
}

test('store key：命名空间前缀与反向解析', () => {
  assert.equal(HOST_STORE_KEY_PREFIX, 'store:')
  assert.equal(hostStoreKey('auth'), 'store:auth')
  assert.equal(isHostStoreKey('store:auth'), true)
  assert.equal(isHostStoreKey('user'), false)
  assert.equal(hostStoreIdFromKey('store:auth'), 'auth')
  assert.equal(hostStoreIdFromKey('user'), null)
})

test('cloneHostState：纯数据深拷贝、不共享引用、循环引用不炸', () => {
  const source = { token: 'tk', user: { name: '张三', tags: ['a', 'b'] }, at: new Date(0) }
  const copy = cloneHostState(source)
  assert.notEqual(copy, source)
  assert.notEqual(copy.user, source.user)
  assert.notEqual(copy.user.tags, source.user.tags)
  assert.deepEqual(copy.user.tags, ['a', 'b'])
  assert.ok(copy.at instanceof Date)
  assert.notEqual(copy.at, source.at)

  const cyclic = { name: 'x' }
  cyclic.self = cyclic
  const clonedCyclic = cloneHostState(cyclic)
  assert.equal(clonedCyclic.self, clonedCyclic, '循环引用还原成自引用，不无限递归')

  const fn = () => 1
  assert.equal(cloneHostState({ fn }).fn, fn, '函数按引用传（非纯数据形态保持原样）')
  assert.equal(cloneHostState(null), null)
  assert.equal(cloneHostState(3), 3)
})

test('pusher：pinia 插件自动挂钩 —— 创建即推一次，变更后推新对象（快照）', () => {
  const runtime = fakeRuntime()
  const pusher = createHostStorePusher({ getRuntime: () => runtime })
  const pinia = fakePinia()
  pinia.use(pusher.plugin)

  const auth = pinia.installTo(fakeStore('auth', { token: 'tk-1', user: { name: '张三' } }))
  assert.equal(runtime.patches.length, 1, 'store 创建即推一次')
  assert.deepEqual(runtime.patches[0], { 'store:auth': { token: 'tk-1', user: { name: '张三' } } })
  assert.notEqual(runtime.patches[0]['store:auth'], auth.$state, '推的是快照（新对象），不是 $state 引用')
  assert.notEqual(runtime.patches[0]['store:auth'].user, auth.$state.user, '嵌套对象也不共享引用')

  auth.$state.token = 'tk-2'
  auth.touch()
  assert.equal(runtime.patches.length, 2)
  assert.equal(runtime.patches[1]['store:auth'].token, 'tk-2')

  pusher.dispose()
  auth.$state.token = 'tk-3'
  auth.touch()
  assert.equal(runtime.patches.length, 2, 'dispose 后不再推')
})

test('pusher：only 白名单、手动 push 幂等、store.$dispose 自动解绑、runtime 未就绪不抛错', () => {
  const holder = { runtime: null }
  const pusher = createHostStorePusher({ getRuntime: () => holder.runtime, only: ['auth'] })
  const pinia = fakePinia()
  pinia.use(pusher.plugin)

  pinia.installTo(fakeStore('cart', { n: 1 }))
  assert.equal(holder.runtime, null, '不在白名单里的 store 不桥（也没触发 setState）')

  const auth = fakeStore('auth', { token: 'tk' })
  assert.doesNotThrow(() => pusher.push(auth), '宿主首屏 runtime 还没 init 完也不该抛')
  const runtime = fakeRuntime()
  holder.runtime = runtime
  pusher.push(auth)
  pusher.push(auth)
  assert.equal(runtime.patches.length, 2, 'push 每次都推一次快照（供 runtime 就绪 / 手动补推）')
  assert.deepEqual(runtime.patches[1], { 'store:auth': { token: 'tk' } }, '推的是那一刻的最新值')
  assert.equal(auth.listenerCount(), 1, '订阅只装一次（幂等）')

  auth.$dispose()
  auth.touch()
  assert.equal(runtime.patches.length, 2, 'store.$dispose 之后解绑（不再有新的推送）')
  assert.equal(auth.disposed, true, '没有吞掉原来的 $dispose')
})

test('applyHostStorePatch：id 匹配才应用，且应用的是克隆载荷', () => {
  const auth = fakeStore('auth', {})
  const payload = { id: 'auth', patch: { token: 'tk-x', user: { name: '张三' } } }
  assert.equal(applyHostStorePatch(auth, payload), true)
  assert.equal(auth.$state.token, 'tk-x')
  assert.notEqual(auth.patches[0], payload.patch, '应用的是克隆后的载荷')
  assert.notEqual(auth.patches[0].user, payload.patch.user)
  assert.equal(applyHostStorePatch(auth, { id: 'cart', patch: { n: 1 } }), false)
  assert.equal(applyHostStorePatch(auth, null), false)
  assert.equal(applyHostStorePatch(auth, { id: 'auth' }), false)
})

test('mirror：宿主先推 → 页面 store 建得晚也能 hydrate（且不共享嵌套引用）', () => {
  const state = shallowReactive({})
  const mirror = createStoreMirror()
  mirror.attach({ state })
  const pinia = fakePinia()
  pinia.use(mirror.plugin)

  state['store:auth'] = { token: 'tk-1', user: { name: '张三' } }
  const auth = pinia.installTo(fakeStore('auth', { token: '', user: null }))

  assert.equal(auth.$state.token, 'tk-1')
  assert.equal(auth.$state.user.name, '张三')
  assert.notEqual(auth.$state.user, state['store:auth'].user, 'hydrate 时克隆：不与宿主快照共享嵌套引用')
  mirror.dispose()
})

test('mirror：页面 store 建得早 → 宿主后续推送即时镜像（watch）', async () => {
  const state = shallowReactive({})
  const mirror = createStoreMirror()
  mirror.attach({ state })
  const pinia = fakePinia()
  pinia.use(mirror.plugin)

  const auth = pinia.installTo(fakeStore('auth', { token: '' }))
  state['store:auth'] = { token: 'tk-2', user: { name: '李四' } }
  await nextTick()
  assert.equal(auth.$state.token, 'tk-2')
  assert.equal(auth.$state.user.name, '李四')

  state['store:auth'] = { token: 'tk-3', user: null }
  await nextTick()
  assert.equal(auth.$state.token, 'tk-3', '连续两次推送（不同对象）都生效')

  mirror.dispose()
  state['store:auth'] = { token: 'tk-4', user: null }
  await nextTick()
  assert.equal(auth.$state.token, 'tk-3', 'dispose 后不再同步')
})

test('mirror：attach 晚于 store 创建 —— 补 hydrate 且后续继续同步（context 是 shallowRef 依赖）', async () => {
  const mirror = createStoreMirror()
  const pinia = fakePinia()
  pinia.use(mirror.plugin)
  const auth = pinia.installTo(fakeStore('auth', { token: '' })) // 建的时候还没有 context

  const state = shallowReactive({ 'store:auth': { token: 'tk-late' } })
  mirror.attach({ state })
  assert.equal(auth.$state.token, 'tk-late', 'attach 时补 hydrate')

  state['store:auth'] = { token: 'tk-late-2' }
  await nextTick()
  assert.equal(auth.$state.token, 'tk-late-2', 'attach 之后 watch 仍然生效')
  mirror.dispose()
})

test('mirror：only 白名单 + twoWay 回传 store-patch', () => {
  const state = shallowReactive({})
  const events = []
  const mirror = createStoreMirror({ twoWay: true, only: ['auth'] })
  mirror.attach({ state, emit: (event, payload) => events.push([event, payload]) })
  const pinia = fakePinia()
  pinia.use(mirror.plugin)

  pinia.installTo(fakeStore('cart', { n: 1 }))
  assert.equal(events.length, 0, '不在白名单里的 store 不回传')

  const auth = pinia.installTo(fakeStore('auth', { token: 'tk-1' }))
  auth.$state.token = 'tk-local'
  auth.touch()
  assert.deepEqual(events, [[STORE_PATCH_EVENT, { id: 'auth', patch: { token: 'tk-local' } }]])
  assert.equal(Object.getPrototypeOf(events[0][1].patch), Object.prototype, '回传的是纯数据快照')
  mirror.dispose()
})
