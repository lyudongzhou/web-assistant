import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../dist/analyze.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(here, 'fixtures', 'analyze-demo', 'wc.pages.json')

test('analyze：events(名字数组) + emits(富信息) + exposes 双写进 manifest', async () => {
  const manifest = await analyze({ configPath, noAi: true })

  const page = manifest.pages.find((p) => p.tag === 'user-list')
  assert.deepEqual(page.props, [{ name: 'keyword', type: 'String', description: '' }])
  // events 是 runtime CE 监听白名单，必须保持名字数组
  assert.deepEqual(page.events, ['search'])
  // emits / exposes 是给 agent 的富信息
  assert.deepEqual(page.emits, [{ name: 'search' }])
  assert.deepEqual(page.exposes, [
    { name: 'refresh', signature: '() => number', description: '刷新列表，返回条数' },
  ])

  // 无 define* 的页面：字段省略而不是空数组（避免 manifest 噪音）
  const plain = manifest.pages.find((p) => p.tag === 'plain')
  assert.deepEqual(plain.events, [])
  assert.equal(plain.emits, undefined)
  assert.equal(plain.exposes, undefined)
})
