import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
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

test('analyze：无 container（宿主直连批次，用法 B）→ 不写 containers / pages[].bundle', async () => {
  const manifest = await analyze({ configPath, noAi: true })
  assert.deepEqual(manifest.containers, {}, '宿主直连批次不产出容器')
  for (const page of manifest.pages) {
    assert.equal(page.bundle, undefined, '页面就是宿主的路由组件，不经产物编译')
  }
  // 页面目录信息本身照旧齐全（agent 靠它匹配意图）
  assert.equal(manifest.pages[0].name, 'UserList')
  assert.equal(manifest.pages[0].framework, 'vue')
  assert.equal(manifest.pages[0].path, '/users')
})

test('analyze：页面源码里读 route.query → params 带查询通道（path 无 :param）', async () => {
  const manifest = await analyze({ configPath, noAi: true })

  const page = manifest.pages.find((p) => p.tag === 'query-page')
  assert.equal(page.path, '/query')
  assert.deepEqual(page.params, [
    // 源码探测：String(route.query.name || '') / Number(route.query.page || 1)
    { name: 'name', type: 'string', in: 'query', description: '按名称过滤' },
    { name: 'page', type: 'number', in: 'query' },
    // 清单显式声明（page.query）覆盖探测结果
    { name: 'sort', type: 'string', in: 'query', description: '排序字段（清单显式声明）' },
  ])

  // path 里有 :param 的页面：path 参数不带 in 字段（缺省即 path），探测到的 query 参数带 in
  const detailPage = manifest.pages.find((p) => p.tag === 'plain')
  assert.deepEqual(detailPage.params, [])
})

test('analyze：wc.pages.json 的 dataSources 原样进 manifest.pages[].dataSources', async () => {
  const manifest = await analyze({ configPath, noAi: true })

  const page = manifest.pages.find((p) => p.tag === 'user-list')
  assert.deepEqual(page.dataSources, [
    { match: '/api/users', fields: ['id', 'name', 'role'], maxRows: 20, primaryKey: 'id' },
  ])
  // 未声明 dataSources 的页面不写字段（避免噪音）
  const plain = manifest.pages.find((p) => p.tag === 'plain')
  assert.equal(plain.dataSources, undefined)
})

test('analyze：声明 container（WC 批次）→ 照旧写 containers 与 pages[].bundle', async () => {
  // 复制 fixture 到临时目录并补上 container（避免污染仓库内 fixture）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-analyze-'))
  try {
    const fixtureDir = path.join(here, 'fixtures', 'analyze-demo')
    for (const file of ['UserList.vue', 'Plain.vue']) {
      fs.copyFileSync(path.join(fixtureDir, file), path.join(tmp, file))
    }
    const wcPages = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    wcPages.container = 'src/ce/container.ts'
    const tmpConfig = path.join(tmp, 'wc.pages.json')
    fs.writeFileSync(tmpConfig, JSON.stringify(wcPages, null, 2))

    const manifest = await analyze({ configPath: tmpConfig, noAi: true })
    assert.deepEqual(manifest.containers, {
      vue: { bundle: 'containers/vue.js', tagName: 'runtime-vue' },
    })
    assert.equal(manifest.pages[0].bundle, 'pages/userList.js', 'WC 批次照旧带页面产物路径')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
