import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContainerManager } from '../dist/containers.js'
import { createBundleLoader } from '../dist/loader.js'
import { createServicesRef } from '../dist/services.js'
import { createFakeAdapter, fakeRoot } from './helpers.js'

const navApi = {
  push: async () => ({ ok: false, reason: 'aborted' }),
  replace: async () => ({ ok: false, reason: 'aborted' }),
  back: async () => ({ ok: false, reason: 'aborted' }),
  forward: async () => ({ ok: false, reason: 'aborted' }),
  go: async () => ({ ok: false, reason: 'aborted' }),
  current: () => null,
  canGoBack: false,
  canGoForward: false,
}

function setup(options = {}) {
  const vue = createFakeAdapter('vue')
  const react = createFakeAdapter('react')
  const loader = createBundleLoader(async (url) => {
    if (url === 'containers/vue.js') return { default: vue.adapter }
    if (url === 'containers/react.js') return { default: react.adapter }
    if (url === 'containers/bad.js') return { default: { framework: 'other' } }
    throw new Error(`未知容器：${url}`)
  })
  const manager = createContainerManager({
    containers: [
      { framework: 'vue', tagName: 'runtime-vue', bundle: 'containers/vue.js' },
      { framework: 'react', tagName: 'runtime-react', bundle: 'containers/react.js' },
    ],
    loader,
    servicesRef: createServicesRef({}),
    navigation: navApi,
    ...options,
  })
  return { manager, vue, react }
}

const view = (framework, tag, status = 'ready') => ({
  framework,
  tag,
  props: {},
  styles: [],
  stylesVersion: 1,
  status,
})

test('containers：按 framework 懒建，未用到的容器不加载', async () => {
  const { manager, vue, react } = setup()
  manager.setRoot(fakeRoot())
  await manager.ensure('vue')
  assert.deepEqual(vue.calls, ['defineContainer:runtime-vue', 'mount:runtime-vue'])
  assert.deepEqual(react.calls, [], 'react 容器没被建')
})

test('containers：并发 ensure 只建一次', async () => {
  const { manager, vue } = setup()
  manager.setRoot(fakeRoot())
  await Promise.all([manager.ensure('vue'), manager.ensure('vue'), manager.ensure('vue')])
  assert.equal(vue.calls.filter((c) => c.startsWith('defineContainer')).length, 1)
})

test('containers：setRoot 晚于 ensure 时补挂载', async () => {
  const { manager, vue } = setup()
  await manager.ensure('vue')
  assert.deepEqual(vue.calls, ['defineContainer:runtime-vue'])
  manager.setRoot(fakeRoot())
  assert.deepEqual(vue.calls, ['defineContainer:runtime-vue', 'mount:runtime-vue'])
})

test('containers：预注册 adapter 无需容器 bundle', async () => {
  const local = createFakeAdapter('vue')
  const manager = createContainerManager({
    containers: [],
    adapters: [local.adapter],
    loader: createBundleLoader(async () => {
      throw new Error('不应该加载任何 bundle')
    }),
    servicesRef: createServicesRef({}),
    navigation: navApi,
  })
  manager.setRoot(fakeRoot())
  const entry = await manager.ensure('vue')
  assert.equal(entry.tagName, 'runtime-vue', '回落到 adapter.defaultTagName')
  assert.deepEqual(local.calls, ['defineContainer:runtime-vue', 'mount:runtime-vue'])
})

test('containers：容器 bundle 的 framework 与 manifest 不一致时报错', async () => {
  const manager = createContainerManager({
    containers: [{ framework: 'other-x', tagName: 'runtime-x', bundle: 'containers/bad.js' }],
    loader: createBundleLoader(async () => ({ default: { framework: 'other' } })),
    servicesRef: createServicesRef({}),
    navigation: navApi,
  })
  await assert.rejects(() => manager.ensure('other-x'), /未默认导出合法 adapter/)
})

test('containers：没有 adapter 也没有 bundle 时报错', async () => {
  const manager = createContainerManager({
    containers: [],
    loader: createBundleLoader(async () => ({})),
    servicesRef: createServicesRef({}),
    navigation: navApi,
  })
  await assert.rejects(() => manager.ensure('svelte'), /既没有预注册 adapter/)
})

test('containers：keep 策略 —— 跨框架切换时源容器被清空但保留实例', async () => {
  const { manager, vue, react } = setup({ strategy: 'keep' })
  manager.setRoot(fakeRoot())
  await manager.ensure('vue')
  await manager.ensure('react')
  manager.patch('react', view('react', 'r-page'))
  manager.deactivateOthers('react', 2)

  assert.ok(react.calls.includes('patch:react:r-page:ready'))
  assert.ok(vue.calls.includes('patch:vue:null:idle'), 'vue 容器被清空')
  assert.ok(!vue.calls.some((c) => c.startsWith('unmount')), 'keep 策略不卸载')
  assert.ok(manager.get('vue'), '实例仍在，切回来无需重建')
})

test('containers：unmount 策略 —— 跨框架切换时源容器被卸载', async () => {
  const { manager, vue } = setup({ strategy: 'unmount' })
  manager.setRoot(fakeRoot())
  await manager.ensure('vue')
  await manager.ensure('react')
  manager.deactivateOthers('react', 2)

  assert.ok(vue.calls.includes('unmount:runtime-vue'))
  assert.equal(manager.get('vue'), undefined)
})

test('containers：dispose 卸载全部容器', async () => {
  const { manager, vue, react } = setup()
  manager.setRoot(fakeRoot())
  await manager.ensure('vue')
  await manager.ensure('react')
  manager.dispose()
  assert.ok(vue.calls.includes('unmount:runtime-vue'))
  assert.ok(react.calls.includes('unmount:runtime-react'))
  assert.equal(manager.get('vue'), undefined)
})
