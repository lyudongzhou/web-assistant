// lib/welcome.ts 单测：欢迎页（渲染区空态）的判定与合并逻辑。
// 定义：欢迎页 = runtime 当前没有页面（没有渲染子 WC，currentTag === null）时渲染区的默认内容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_WELCOME_TEXT,
  resolveWelcomeCapabilities,
  resolveWelcomeComponent,
  resolveWelcomeLoading,
  resolveWelcomeText,
  resolveWelcomeVariant,
} from '../src/lib/welcome.ts'

test('resolveWelcomeVariant：有当前页 → page（渲染区由页面接管，不显示欢迎页）', () => {
  assert.equal(resolveWelcomeVariant({ currentTag: 'datasource-admin', loading: false }), 'page')
  // 「有页面」压过加载态（页面在加载中也不该显示欢迎页）
  assert.equal(resolveWelcomeVariant({ currentTag: 'datasource-admin', loading: true }), 'page')
})

test('resolveWelcomeVariant：无页（没有渲染子 WC）→ 欢迎页；内容未就绪 → 加载态', () => {
  assert.equal(resolveWelcomeVariant({ currentTag: null, loading: false }), 'welcome')
  assert.equal(resolveWelcomeVariant({ currentTag: null, loading: true }), 'welcome-loading')
})

test('resolveWelcomeLoading：两个数据源都未 settle 才算加载中（失败也算 settle，避免死转圈）', () => {
  assert.equal(resolveWelcomeLoading({ sessionReady: false, manifestSettled: false }), true)
  assert.equal(resolveWelcomeLoading({ sessionReady: true, manifestSettled: false }), false)
  assert.equal(resolveWelcomeLoading({ sessionReady: false, manifestSettled: true }), false)
  assert.equal(resolveWelcomeLoading({ sessionReady: true, manifestSettled: true }), false)
})

test('resolveWelcomeText：优先握手载荷；空/空白 → 回退内置默认文案', () => {
  assert.equal(resolveWelcomeText({ text: '来自 agent 的欢迎语', capabilities: [] }), '来自 agent 的欢迎语')
  assert.equal(resolveWelcomeText(null), DEFAULT_WELCOME_TEXT)
  assert.equal(resolveWelcomeText(undefined), DEFAULT_WELCOME_TEXT)
  assert.equal(resolveWelcomeText({ text: '   ', capabilities: [] }), DEFAULT_WELCOME_TEXT)
  assert.equal(resolveWelcomeText({ text: ' 有空格 ', capabilities: [] }), '有空格')
  assert.equal(resolveWelcomeText(null, '自定义兜底'), '自定义兜底')
  // 默认文案里的换行必须是真换行（不是字面量 \n）
  assert.ok(DEFAULT_WELCOME_TEXT.includes('\n'))
})

test('resolveWelcomeCapabilities：握手载荷优先（含 description/examples）', () => {
  const payload = {
    text: 'x',
    capabilities: [{ tag: 'a', name: 'A', title: '页面 A', description: '说明', examples: ['例子'] }],
  }
  const routes = [{ tag: 'b', name: 'B', title: '页面 B' }]
  assert.deepEqual(resolveWelcomeCapabilities(payload, routes), payload.capabilities)
})

test('resolveWelcomeCapabilities：载荷为空（旧服务端）→ 用本地 manifest 路由兜底', () => {
  const routes = [
    { tag: 'datasource-admin', name: 'DatasourceAdmin', title: '数据源管理' },
    { tag: 'graph-demo', name: 'GraphDemo' },
  ]
  assert.deepEqual(resolveWelcomeCapabilities(null, routes), [
    { tag: 'datasource-admin', name: 'DatasourceAdmin', title: '数据源管理' },
    { tag: 'graph-demo', name: 'GraphDemo' },
  ])
  // 空 capabilities 数组同样视为「没下发」
  assert.deepEqual(resolveWelcomeCapabilities({ text: 'x', capabilities: [] }, routes).length, 2)
})

test('resolveWelcomeComponent：false 关闭；组件原样透传；缺省/非法值回退内置', () => {
  const fallback = { name: 'BuiltinWelcome' }
  assert.equal(resolveWelcomeComponent(false, fallback), null, '显式 false = 关闭欢迎页')
  const fn = () => null
  assert.equal(resolveWelcomeComponent(fn, fallback), fn, '函数组件原样')
  const obj = { name: 'Custom' }
  assert.equal(resolveWelcomeComponent(obj, fallback), obj, '对象组件原样')
  assert.equal(resolveWelcomeComponent(undefined, fallback), fallback, '缺省 → 内置')
  assert.equal(resolveWelcomeComponent(null, fallback), fallback, 'null → 内置')
  // Vue 布尔转换的副产物（bare attr / 空串）不应当成组件，也回退内置
  assert.equal(resolveWelcomeComponent(true, fallback), fallback)
  assert.equal(resolveWelcomeComponent('', fallback), fallback)
})

test('resolveWelcomeCapabilities：两边都没有 → 空数组（组件据此显示空态提示）', () => {
  assert.deepEqual(resolveWelcomeCapabilities(null, []), [])
  assert.deepEqual(resolveWelcomeCapabilities(null, undefined), [])
  assert.deepEqual(resolveWelcomeCapabilities(null, null), [])
})
