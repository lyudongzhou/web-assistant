import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanRouteAccess, resolvePageParams } from '../dist/routeScan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => path.join(here, 'fixtures', name)
const PROPS = [{ name: 'status', type: '"paid" | "all"', description: '状态' }]

test('scanRouteAccess：识别六种 query 读法并按源码顺序给出通道标记', () => {
  const facts = scanRouteAccess(fixture('RouteQueryPage.vue'), { props: PROPS })

  // 顺序 = 源码里首次被读到的顺序（脚本内的读在前，模板里的 templateKey 最后）
  assert.deepEqual(
    facts.queries.map((item) => item.name),
    ['name', 'page', 'tab', 'keyword', 'sort', 'from', 'flag', 'status', 'templateKey'],
  )
  for (const item of facts.queries) assert.equal(item.in, 'query')

  const byName = new Map(facts.queries.map((item) => [item.name, item]))
  // ① 包装调用 + 就近 JSDoc
  assert.deepEqual(byName.get('name'), {
    name: 'name',
    type: 'string',
    in: 'query',
    description: '标题里的规则名',
  })
  // ② Number(...) / `|| 1`
  assert.equal(byName.get('page').type, 'number')
  // ③ { query: q } 别名 + `|| 'all'`
  assert.equal(byName.get('tab').type, 'string')
  // ④ 解构重命名 + 声明处 JSDoc
  assert.equal(byName.get('keyword').description, '关键词（解构重命名）')
  // ⑤ route.query['sort'] 字面量键 / ⑥ 内联 useRoute().query.x
  assert.equal(byName.get('sort').type, 'string')
  assert.equal(byName.get('from').type, 'string')
  // 多行 JSDoc 只取第一行（续行是开发者向说明，不该出网进 agent prompt）
  assert.equal(byName.get('from').description, '来源标记（多行 JSDoc 的第一行）')
  // ⑦ 恒等比较
  assert.equal(byName.get('flag').type, 'boolean')
  // ⑧ 同名 props 声明优先（且不产生第二个同名参数）
  assert.equal(byName.get('status').type, '"paid" | "all"')
  assert.equal(byName.get('status').description, '状态')
  // ⑨ 模板里的 route.query.templateKey
  assert.equal(byName.get('templateKey').type, 'string')
})

test('scanRouteAccess：route.params 读取被记录（用于与 path 对账）', () => {
  const facts = scanRouteAccess(fixture('RouteQueryPage.vue'))
  assert.deepEqual(facts.paramReads, ['legacyId'])
})

test('scanRouteAccess：整块读 / 动态键给出「无法枚举」诊断', () => {
  const facts = scanRouteAccess(fixture('RouteQueryPage.vue'))
  assert.equal(facts.warnings.length, 2)
  assert.ok(facts.warnings.every((item) => item.includes('无法枚举键')), facts.warnings.join(' / '))
})

test('scanRouteAccess：没有 useRoute 绑定时不误报（http.query.a 不是路由入参）', () => {
  const facts = scanRouteAccess(fixture('PlainQueryNoisePage.vue'))
  assert.deepEqual(facts, { queries: [], paramReads: [], warnings: [] })
})

test('scanRouteAccess：params 通道的「无法枚举」诊断指向 path / query，而不是不存在的 params 声明字段', () => {
  const facts = scanRouteAccess(fixture('ParamsRestPage.vue'))
  assert.equal(facts.warnings.length, 2)
  assert.ok(facts.warnings.every((item) => item.includes('无法枚举键')), facts.warnings.join(' / '))
  assert.ok(facts.warnings.every((item) => item.includes('route.params')), facts.warnings.join(' / '))
  assert.ok(facts.warnings.every((item) => !item.includes('用 params 显式声明')), facts.warnings.join(' / '))
  // query 通道照旧可用
  assert.deepEqual(
    facts.queries.map((item) => item.name),
    ['keyword'],
  )
})

test('resolvePageParams：path + 探测 + 显式声明按 (name, in) 合并，显式覆盖说明', () => {
  const { params, warnings } = resolvePageParams('/datasources', fixture('RouteQueryPage.vue'), {
    props: PROPS,
    explicit: [
      { name: 'keyword', type: 'string', description: '按名称过滤（清单显式声明）' },
      { name: 'sort', type: 'string', description: '排序字段（清单显式声明）' },
    ],
  })

  const query = params.filter((item) => item.in === 'query')
  const keyword = query.find((item) => item.name === 'keyword')
  assert.deepEqual(keyword, {
    name: 'keyword',
    type: 'string',
    in: 'query',
    description: '按名称过滤（清单显式声明）',
  })
  assert.equal(query.filter((item) => item.name === 'keyword').length, 1, '同名同通道只留一条')
  // 显式声明可以补探测不到（或探测不到说明）的键
  const sort = query.find((item) => item.name === 'sort')
  assert.equal(sort.description, '排序字段（清单显式声明）')
  // path 正则仍然产出 path 通道参数（且不带 in 字段）
  assert.equal(params.some((item) => item.in === undefined), false, '/datasources 没有 :param')
  // 诊断：2 条「无法枚举」（整块读 / 动态键）+ 1 条 route.params 与 path 不一致
  assert.equal(warnings.length, 3)
  assert.equal(warnings.filter((item) => item.includes('无法枚举键')).length, 2)
  const mismatch = warnings.find((item) => item.includes('legacyId'))
  assert.match(mismatch, /route\.params\.legacyId/)
  assert.match(mismatch, /没有 :legacyId/)
})

test('resolvePageParams：同名双通道（path + query）都保留', () => {
  const { params, warnings } = resolvePageParams('/users/:id', fixture('RouteQueryDualPage.vue'))
  assert.deepEqual(params, [
    { name: 'id', type: 'string' },
    { name: 'id', type: 'string', in: 'query' },
  ])
  assert.match(warnings[0], /route\.params\.legacyId/)
})

test('resolvePageParams：组件不存在时只按 path 出参（不抛错）', () => {
  const { params, warnings } = resolvePageParams('/users/:id', null, { explicit: [{ name: 'tab', type: 'string' }] })
  assert.deepEqual(params, [
    { name: 'id', type: 'string' },
    { name: 'tab', type: 'string', in: 'query' },
  ])
  assert.deepEqual(warnings, [])
})

test('resolvePageParams：显式 query 声明与 path 段同名时给出「双通道」告警', () => {
  const { params, warnings } = resolvePageParams('/users/:id', null, { explicit: [{ name: 'id', type: 'string' }] })
  // 双通道本身合法（path 与 query 各一条），只是提醒「多半不是本意」
  assert.deepEqual(params, [
    { name: 'id', type: 'string' },
    { name: 'id', type: 'string', in: 'query' },
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /query 里声明了「id」/)
  assert.match(warnings[0], /path「\/users\/:id」里已有 :id/)
})
