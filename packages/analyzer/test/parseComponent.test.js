import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseComponent } from '../dist/parseComponent.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => path.join(here, 'fixtures', name)

test('defineExpose：标识符引用回查顶层函数的签名与 JSDoc', () => {
  const parsed = parseComponent(fixture('ExposePage.vue'))

  assert.deepEqual(
    parsed.exposes.map((m) => m.name),
    ['refresh', 'setStatus', 'exportedAlias', 'renamed-key'],
    'SpreadElement 跳过、key 顺序保持',
  )
  assert.deepEqual(parsed.exposes[0], {
    name: 'refresh',
    signature: '() => Promise<number>',
    description: '重新拉取当前筛选条件下的数据，返回条数',
  })
  assert.deepEqual(parsed.exposes[1], {
    name: 'setStatus',
    signature: '(next: "paid" | "all", keepPage?) => boolean',
    description: '切换筛选状态',
  })
  // 引用了未登记的标识符（重导出别名）：只给名字，不编造 signature
  assert.equal(parsed.exposes[2].signature, undefined)
  assert.equal(parsed.exposes[2].description, undefined)
  // 字符串 key 照常取，签名仍回查到声明处
  assert.equal(parsed.exposes[3].name, 'renamed-key')
  assert.equal(parsed.exposes[3].signature, '(next: "paid" | "all", keepPage?) => boolean')
})

test('defineExpose：内联箭头函数直接取形参签名', () => {
  const parsed = parseComponent(fixture('EmitsArrayPage.vue'))
  assert.deepEqual(parsed.exposes, [{ name: 'search', signature: '()', description: undefined }])
})

test('defineEmits：数组写法取名字；泛型写法取 payloadType 与调用签名', () => {
  const arrayForm = parseComponent(fixture('EmitsArrayPage.vue'))
  assert.deepEqual(arrayForm.events, [{ name: 'search' }, { name: 'page-change' }])

  const typed = parseComponent(fixture('EmitsTypedPage.vue'))
  assert.deepEqual(typed.events[0], {
    name: 'filter',
    payloadType: '[status: "paid" | "all", keepPage?: boolean]',
    description: '筛选状态变化',
  })
  assert.deepEqual(typed.events[1], { name: 'view', description: '' })
})

test('defineProps：类型写法取名字不回归', () => {
  const parsed = parseComponent(fixture('ExposePage.vue'))
  assert.deepEqual(
    parsed.props.map((p) => p.name),
    ['status', 'page'],
  )
})

test('无 define* 调用的页面：返回空结构不抛错', () => {
  const parsed = parseComponent(fixture('PlainPage.vue'))
  assert.deepEqual(parsed, { description: '', props: [], events: [], exposes: [] })
})
