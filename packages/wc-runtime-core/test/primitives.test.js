import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBundleLoader } from '../dist/loader.js'
import { createStyleRegistry } from '../dist/styles.js'
import { coerceValue, resolveProps } from '../dist/props.js'
import { createEventBus } from '../dist/events.js'
import { normalizeManifest } from '../dist/manifest.js'
import { makeManifest } from './helpers.js'

test('loader：并发同一 URL 只 import 一次', async () => {
  let count = 0
  const loader = createBundleLoader(async (url) => {
    count += 1
    return { url }
  })
  const [a, b, c] = await Promise.all([
    loader.load('x.js'),
    loader.load('x.js'),
    loader.load('x.js'),
  ])
  assert.equal(count, 1)
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(loader.isLoaded('x.js'), true)
  await loader.load('x.js')
  assert.equal(count, 1, '成功结果被缓存')
})

test('loader：失败不缓存，可重试', async () => {
  let attempts = 0
  const loader = createBundleLoader(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('boom')
    return { ok: true }
  })
  await assert.rejects(() => loader.load('y.js'), /boom/)
  const mod = await loader.load('y.js')
  assert.deepEqual(mod, { ok: true })
  assert.equal(attempts, 2)
})

test('loader：reset 清缓存', async () => {
  let count = 0
  const loader = createBundleLoader(async () => ({ n: (count += 1) }))
  await loader.load('z.js')
  loader.reset('z.js')
  await loader.load('z.js')
  assert.equal(count, 2)
})

test('styles：base → shared → page 顺序 + 去重 + version 单调', () => {
  const styles = createStyleRegistry()
  assert.equal(styles.version, 0)
  styles.add('page', 'user-list', '.page{}')
  styles.add('base', 'element-plus', '.base{}')
  styles.add('shared', 'tokens', '.shared{}')
  assert.deepEqual(styles.toArray(), ['.base{}', '.shared{}', '.page{}'])
  assert.equal(styles.version, 3)

  assert.equal(styles.add('base', 'element-plus', '.base{}'), false, '同 id 去重')
  assert.equal(styles.version, 3, '去重不 bump 版本')
})

test('styles：addMany 幂等 + 订阅通知', () => {
  const styles = createStyleRegistry()
  const versions = []
  styles.subscribe((v) => versions.push(v))
  assert.equal(styles.addMany('page', 'user-list', ['.a{}', '.b{}']), true)
  assert.equal(styles.addMany('page', 'user-list', ['.a{}', '.b{}']), false)
  assert.deepEqual(styles.toArray(), ['.a{}', '.b{}'])
  assert.deepEqual(versions, [1, 2])
})

test('styles：append-only —— 新增不重排已有顺序', () => {
  const styles = createStyleRegistry()
  styles.add('page', 'a', '.a{}')
  styles.add('page', 'b', '.b{}')
  const before = styles.toArray()
  styles.add('page', 'c', '.c{}')
  assert.deepEqual(styles.toArray().slice(0, 2), before)
})

test('props：按声明类型归一，对象保持引用', () => {
  assert.equal(coerceValue('3', 'Number'), 3)
  assert.equal(coerceValue('abc', 'Number'), 'abc')
  assert.equal(coerceValue('true', 'Boolean'), true)
  assert.equal(coerceValue('0', 'Boolean'), false)
  assert.deepEqual(coerceValue('[1,2]', 'Array'), [1, 2])
  const obj = { a: 1 }
  assert.equal(coerceValue(obj, 'Object'), obj, '非字符串原样返回（不 stringify）')
  assert.equal(coerceValue(undefined, 'Number'), undefined)
})

test('props：params + 声明 props + 直传 props 的优先级', () => {
  const [list, detail] = normalizeManifest(makeManifest()).routes
  // 路由参数按 params[].type 归一后也下发为 props，方便页面直接用
  assert.deepEqual(resolveProps({ route: detail, params: { id: '7' } }), { id: '7' })

  const user = { id: 7, name: 'x' }
  assert.deepEqual(resolveProps({ route: detail, params: { id: '7' }, props: { user } }), {
    id: '7',
    user,
  })

  // 直传优先于 params 同名
  assert.deepEqual(
    resolveProps({ route: list, params: { users: '[1]' }, props: { users: [2] } }).users,
    [2],
  )
  // 未声明的键也透传（研究阶段宽松）
  assert.deepEqual(resolveProps({ route: list, props: { extra: 1 } }).extra, 1)
})

test('events：订阅 / 取消 / handler 内取消不影响本次派发', () => {
  const bus = createEventBus()
  const seen = []
  const off1 = bus.on('status', (p) => {
    seen.push(`a:${p.status}`)
    off1()
  })
  bus.on('status', (p) => seen.push(`b:${p.status}`))
  bus.emit('status', { status: 'ready', tag: 't-a' })
  bus.emit('status', { status: 'idle', tag: null })
  assert.deepEqual(seen, ['a:ready', 'b:ready', 'b:idle'])
})
