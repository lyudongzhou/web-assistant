// lib/welcome.ts 单测：欢迎页（渲染区空态）的判定与合并逻辑。
// 定义：欢迎页 = runtime 当前没有页面（没有渲染子 WC，currentTag === null）时渲染区的默认内容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HERO_SUBTITLE,
  DEFAULT_WELCOME_TEXT,
  resolveWelcomeCapabilities,
  resolveWelcomeComponent,
  resolveWelcomeLoading,
  resolveWelcomeText,
  resolveWelcomeVariant,
  splitWelcomeText,
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

// ---- splitWelcomeText：欢迎语拆成 hero 主/副标题（列表丢弃，避免与能力卡片重复）----

test('splitWelcomeText：首行→主标题；「列表之前的散文」→副标题；能力清单列表一律丢弃', () => {
  // agent-server 默认欢迎语的真实结构（buildWelcomeText）
  const agentText = [
    '你好，我是本站的智能助手 👋',
    '我可以理解你的需求，直接帮你打开并操作对应的页面。',
    '',
    '目前我能帮你：',
    '- 数据源管理（例如：帮我新建一个 MySQL 数据源）',
    '- 数据同步（例如：怎么配置数据同步任务？）',
    '',
    '直接说出你想做什么就可以了。',
  ].join('\n')

  assert.deepEqual(splitWelcomeText(agentText), {
    headline: '你好，我是本站的智能助手 👋',
    subtitle: '我可以理解你的需求，直接帮你打开并操作对应的页面。',
  })
})

test('splitWelcomeText：内置默认文案 → 首行主标题 + 第二行副标题', () => {
  const { headline, subtitle } = splitWelcomeText(DEFAULT_WELCOME_TEXT)
  assert.equal(headline, DEFAULT_WELCOME_TEXT.split('\n')[0])
  assert.equal(subtitle, '直接说出你想做什么就可以了。')
})

test('splitWelcomeText：空 / 空白 / null / undefined → 回退内置默认文案', () => {
  const expected = splitWelcomeText(DEFAULT_WELCOME_TEXT)
  assert.deepEqual(splitWelcomeText(''), expected)
  assert.deepEqual(splitWelcomeText('   '), expected)
  assert.deepEqual(splitWelcomeText(null), expected)
  assert.deepEqual(splitWelcomeText(undefined), expected)
})

test('splitWelcomeText：首行之后直接是列表 → 副标题回落内置缺省', () => {
  assert.deepEqual(splitWelcomeText('你好 👋\n- 页面 A\n- 页面 B'), {
    headline: '你好 👋',
    subtitle: DEFAULT_HERO_SUBTITLE,
  })
  // 有序列表 / 全角顿号编号同样算列表
  assert.deepEqual(splitWelcomeText('你好 👋\n1. 页面 A'), {
    headline: '你好 👋',
    subtitle: DEFAULT_HERO_SUBTITLE,
  })
  assert.deepEqual(splitWelcomeText('你好 👋\n1、页面 A'), {
    headline: '你好 👋',
    subtitle: DEFAULT_HERO_SUBTITLE,
  })
  // 以冒号结尾的「列表引导句」也算列表开始
  assert.deepEqual(splitWelcomeText('你好 👋\n我能帮你：\n- 页面 A'), {
    headline: '你好 👋',
    subtitle: DEFAULT_HERO_SUBTITLE,
  })
})

test('splitWelcomeText：只有一行 → 副标题回落内置缺省', () => {
  assert.deepEqual(splitWelcomeText('只有一行'), {
    headline: '只有一行',
    subtitle: DEFAULT_HERO_SUBTITLE,
  })
})

test('splitWelcomeText：副标题最多 2 行（长散文不会把 hero 撑高）', () => {
  const { headline, subtitle } = splitWelcomeText('标题\n一\n二\n三\n四')
  assert.equal(headline, '标题')
  assert.equal(subtitle, '一\n二')
})
