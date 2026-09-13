// resolveInitialTarget 单测：chat-client 首屏默认「不自动打开页面」→ 渲染区展示欢迎页。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveInitialTarget } from '../src/lib/initialPage.ts'

test('缺省 / false / 空串 → null（不自动打开，展示欢迎页）', () => {
  assert.equal(resolveInitialTarget(), null)
  assert.equal(resolveInitialTarget(false), null)
  assert.equal(resolveInitialTarget(''), null)
})

test('true → undefined（交回 runtime 默认：打开第一个页面）', () => {
  assert.equal(resolveInitialTarget(true), undefined)
})

test('字符串 → { tag }（打开指定页面）', () => {
  assert.deepEqual(resolveInitialTarget('datasource-admin'), { tag: 'datasource-admin' })
})
