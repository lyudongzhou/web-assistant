import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeManifest, extractParams } from '../dist/manifest.js'
import { toKebab, pageBundlePath, containerBundlePath } from '@webassistant/protocol'
import { makeManifest } from './helpers.js'

test('manifest：拼 assetBase、提取 params、保留声明', () => {
  const m = normalizeManifest(makeManifest(), { assetBase: '/wc/dist-ce' })
  assert.equal(m.version, 2)
  assert.equal(m.routes.length, 2)
  assert.equal(m.routes[0].bundle, '/wc/dist-ce/pages/userList.js')
  assert.deepEqual(m.routes[1].params, [{ name: 'id', type: 'string' }])
  assert.deepEqual(m.routes[0].props, [{ name: 'users', type: 'Array' }])
  assert.deepEqual(m.containers, [
    { framework: 'vue', tagName: 'runtime-vue', bundle: '/wc/dist-ce/containers/vue.js' },
  ])
})

test('manifest：tag 缺省从 name 推导 kebab-case', () => {
  const m = normalizeManifest(
    makeManifest({
      pages: [{ name: 'AppDashboard', framework: 'vue', bundle: 'pages/appDashboard.js' }],
    }),
    {},
  )
  assert.equal(m.routes[0].tag, 'app-dashboard')
  assert.equal(m.routes[0].path, '/app-dashboard')
})

test('manifest：framework 单容器时可省略', () => {
  const m = normalizeManifest(
    makeManifest({ pages: [{ name: 'OrderList', bundle: 'pages/orderList.js' }] }),
    {},
  )
  assert.equal(m.routes[0].framework, 'vue')
})

test('manifest：多容器且未声明 framework 时报错', () => {
  assert.throws(
    () =>
      normalizeManifest(
        makeManifest({
          containers: { vue: { bundle: 'a.js' }, react: { bundle: 'b.js' } },
          pages: [{ name: 'OrderList', bundle: 'pages/orderList.js' }],
        }),
        {},
      ),
    /未声明 framework/,
  )
})

test('manifest：预注册 adapter 的 framework 无需 containers 条目', () => {
  const m = normalizeManifest(
    { version: 2, pages: [{ name: 'UserList', framework: 'vue', bundle: 'pages/userList.js' }] },
    { preRegisteredFrameworks: ['vue'] },
  )
  assert.equal(m.routes[0].framework, 'vue')
  assert.equal(m.containers.length, 0)
})

test('manifest：校验 —— 版本 / 空 pages / 重复 tag / 非法 tag / 未知 framework', () => {
  assert.throws(() => normalizeManifest({ version: 1, pages: [] }), /不支持的 manifest 版本/)
  assert.throws(() => normalizeManifest({ version: 2, pages: [] }), /pages 不能为空/)
  assert.throws(
    () =>
      normalizeManifest(
        makeManifest({
          pages: [
            { name: 'A', tag: 'x-a', framework: 'vue', bundle: 'a.js' },
            { name: 'B', tag: 'x-a', framework: 'vue', bundle: 'b.js' },
          ],
        }),
      ),
    /重复的 tag/,
  )
  assert.throws(
    () =>
      normalizeManifest(
        makeManifest({ pages: [{ name: 'A', tag: 'nodash', framework: 'vue', bundle: 'a.js' }] }),
      ),
    /必须包含/,
  )
  assert.throws(
    () =>
      normalizeManifest(
        makeManifest({ pages: [{ name: 'A', tag: 'x-a', framework: 'svelte', bundle: 'a.js' }] }),
      ),
    /不存在/,
  )
})

test('manifest：绝对地址不拼 assetBase', () => {
  const m = normalizeManifest(
    makeManifest({
      pages: [{ name: 'A', tag: 'x-a', framework: 'vue', bundle: 'https://cdn/x.js' }],
    }),
    { assetBase: '/wc' },
  )
  assert.equal(m.routes[0].bundle, 'https://cdn/x.js')
})

test('manifest 工具函数', () => {
  assert.equal(toKebab('OntologyModeling'), 'ontology-modeling')
  assert.deepEqual(extractParams('/users/:id/posts/:postId'), [
    { name: 'id', type: 'string' },
    { name: 'postId', type: 'string' },
  ])
})

test('protocol：产物命名规则与 manifest 一致（插件/analyzer/core 共用同一套）', () => {
  assert.equal(pageBundlePath('app-dashboard'), 'pages/appDashboard.js')
  assert.equal(containerBundlePath('vue'), 'containers/vue.js')
  const m = normalizeManifest(
    makeManifest({
      containers: { vue: { bundle: containerBundlePath('vue') } },
      pages: [
        { name: 'AppDashboard', framework: 'vue', bundle: pageBundlePath(toKebab('AppDashboard')) },
      ],
    }),
    { assetBase: '/wc/dist-ce' },
  )
  assert.equal(m.routes[0].tag, 'app-dashboard')
  assert.equal(m.routes[0].bundle, '/wc/dist-ce/pages/appDashboard.js')
  assert.equal(m.containers[0].bundle, '/wc/dist-ce/containers/vue.js')
  assert.equal(m.containers[0].tagName, 'runtime-vue')
})
