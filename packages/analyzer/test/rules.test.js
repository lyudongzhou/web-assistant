// 规则收集单测：wc.pages.json 的 rules 声明（文件/目录/内联）→ manifest.rules。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyze, collectConfigRuleWatchPaths, resolveRuleEntries } from '../dist/analyze.js'

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rules-'))
  fs.mkdirSync(path.join(root, 'rules', 'extra'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'rules', 'domain.md'),
    '---\nname: domain-conventions\n---\n演示数据不得说成生产数据。\n',
  )
  fs.writeFileSync(path.join(root, 'rules', 'order.md'), '下单前先确认库存。\n')
  fs.writeFileSync(path.join(root, 'rules', 'extra', 'b.md'), 'B 规则。\n')
  fs.writeFileSync(path.join(root, 'rules', 'extra', 'a.md'), 'A 规则。\n')
  fs.writeFileSync(path.join(root, 'rules', 'legacy.md'), '---\ndisabled: true\n---\n已停用规则。\n')
  return root
}

test('resolveRuleEntries：文件/目录自动收集/内联/缺失路径', () => {
  const root = makeProject()
  const rules = resolveRuleEntries(root, [
    'rules/domain.md',
    'rules/extra',
    { name: 'inline-rule', content: '内联规则正文。' },
    'rules/missing.md',
    'rules/legacy.md',
  ])

  const byName = Object.fromEntries(rules.map((rule) => [rule.name, rule]))
  // frontmatter 的 name 覆盖文件基名，且 frontmatter 不计入正文
  assert.deepEqual(byName['domain-conventions'], {
    name: 'domain-conventions',
    instructions: '演示数据不得说成生产数据。',
  })
  // 目录内 .md 按文件名排序自动收集
  assert.deepEqual(rules.map((rule) => rule.name).slice(1, 3), ['a', 'b'])
  assert.equal(byName['a'].instructions, 'A 规则。')
  // 内联规则
  assert.equal(byName['inline-rule'].instructions, '内联规则正文。')
  // frontmatter disabled 透传
  assert.equal(byName['legacy'].disabled, true)
  // 缺失路径被跳过
  assert.equal(byName['missing'], undefined)
})

test('resolveRuleEntries：空声明返回 []', () => {
  assert.deepEqual(resolveRuleEntries('/tmp/whatever', undefined), [])
  assert.deepEqual(resolveRuleEntries('/tmp/whatever', []), [])
})

test('analyze：把 wc.pages.json 的 rules 收集进 manifest.rules', async () => {
  const root = makeProject()
  const configPath = path.join(root, 'wc.pages.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      framework: 'vue',
      container: 'container.ts',
      rules: ['rules/domain.md', 'rules/extra'],
      pages: [{ name: 'Plain', component: 'Plain.vue' }],
    }),
  )

  const manifest = await analyze({ configPath, noAi: true })
  assert.deepEqual(
    manifest.rules?.map((rule) => rule.name),
    ['domain-conventions', 'a', 'b'],
  )
  assert.equal(manifest.rules?.[0].instructions, '演示数据不得说成生产数据。')
})

test('analyze：未声明 rules 时不写 manifest.rules（避免噪音）', async () => {
  const root = makeProject()
  const configPath = path.join(root, 'wc.pages.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      framework: 'vue',
      container: 'container.ts',
      pages: [{ name: 'Plain', component: 'Plain.vue' }],
    }),
  )

  const manifest = await analyze({ configPath, noAi: true })
  assert.equal(manifest.rules, undefined)
})

test('analyze：页面级 rules 收集进 manifest.pages[].rules（与 manifest 级并存）', async () => {
  const root = makeProject()
  const configPath = path.join(root, 'wc.pages.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      framework: 'vue',
      container: 'container.ts',
      rules: ['rules/domain.md'],
      pages: [
        { name: 'Plain', component: 'Plain.vue', rules: ['rules/order.md', { name: 'inline-page', content: '页面内联规则。' }] },
        { name: 'Other', component: 'Other.vue' },
      ],
    }),
  )

  const manifest = await analyze({ configPath, noAi: true })
  const plain = manifest.pages.find((p) => p.tag === 'plain')
  const other = manifest.pages.find((p) => p.tag === 'other')
  assert.deepEqual(plain.rules?.map((rule) => rule.name), ['order', 'inline-page'])
  assert.equal(plain.rules?.[0].instructions, '下单前先确认库存。')
  assert.equal(other.rules, undefined, '未声明页面规则时不写字段')
  // manifest 级规则仍在，两级互不影响
  assert.deepEqual(manifest.rules?.map((rule) => rule.name), ['domain-conventions'])
})

test('collectConfigRuleWatchPaths：合并 manifest 级与页面级规则路径（内联项忽略）', () => {
  const paths = collectConfigRuleWatchPaths('/tmp/proj', {
    rules: ['rules/domain.md', { name: 'inline', content: '内联' }],
    pages: [
      { name: 'A', component: 'A.vue', rules: ['rules/a.md'] },
      { name: 'B', component: 'B.vue' },
    ],
  })
  assert.deepEqual(paths, ['/tmp/proj/rules/domain.md', '/tmp/proj/rules/a.md'])
})
