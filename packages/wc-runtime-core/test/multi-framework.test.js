import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../dist/runtime.js'
import { createFakeAdapter, createFakeImporter, fakeRoot } from './helpers.js'

const multiManifest = {
  version: 2,
  pages: [
    {
      name: 'UserList',
      tag: 'user-list',
      path: '/users',
      framework: 'vue',
      bundle: 'pages/userList.js',
    },
    {
      name: 'ReactChart',
      tag: 'react-chart',
      path: '/chart',
      framework: 'react',
      bundle: 'pages/reactChart.js',
    },
  ],
}

function setup(strategy) {
  const vue = createFakeAdapter('vue')
  const react = createFakeAdapter('react')
  const { importImpl } = createFakeImporter()
  const runtime = createRuntime({
    manifest: multiManifest,
    assetBase: '/wc',
    adapters: [vue.adapter, react.adapter],
    importImpl,
    containerStrategy: strategy,
  })
  return { runtime, vue, react }
}

test('多框架：vue / react 两批 WC —— 容器懒建，切换时目标渲染、源清空（keep）', async () => {
  const { runtime, vue, react } = setup('keep')
  await runtime.init(fakeRoot())
  assert.deepEqual(react.calls, [], 'react 容器尚未创建（懒建）')

  await runtime.navigate({ tag: 'react-chart', source: 'agent' })
  assert.deepEqual(react.calls, [
    'defineContainer:runtime-react',
    'mount:runtime-react',
    'patch:react:react-chart:loading',
    'definePage:react-chart',
    'patch:react:react-chart:ready',
  ])
  assert.ok(vue.calls.includes('patch:vue:null:idle'), 'vue 容器被清空')
  assert.ok(!vue.calls.some((c) => c.startsWith('unmount')), 'keep 策略保留实例')

  await runtime.navigate({ tag: 'user-list', source: 'agent' })
  assert.equal(
    vue.calls.filter((c) => c === 'defineContainer:runtime-vue').length,
    1,
    '切回不重建容器',
  )
  assert.ok(react.calls.includes('patch:react:null:idle'))
  runtime.dispose()
})

test('多框架：unmount 策略下源容器被卸载，切回时重建', async () => {
  const { runtime, vue } = setup('unmount')
  await runtime.init(fakeRoot())
  await runtime.navigate({ tag: 'react-chart' })
  assert.ok(vue.calls.includes('unmount:runtime-vue'))
  await runtime.navigate({ tag: 'user-list' })
  assert.equal(
    vue.calls.filter((c) => c === 'defineContainer:runtime-vue').length,
    2,
    '重建一次',
  )
  runtime.dispose()
})

test('多框架：每个容器各自收到自己那一帧 view（framework 隔离）', async () => {
  const { runtime, vue, react } = setup('keep')
  await runtime.init(fakeRoot())
  await runtime.navigate({ tag: 'react-chart' })

  const vueView = vue.handles?.[0]
  assert.equal(vue.adapter.framework, 'vue')
  assert.equal(react.adapter.framework, 'react')
  assert.equal(react.handles[0].views.at(-1).framework, 'react')
  assert.equal(react.handles[0].views.at(-1).tag, 'react-chart')
  assert.equal(vue.handles[0].views.at(-1).tag, null)
  assert.equal(vueView, vue.handles[0])
  runtime.dispose()
})
