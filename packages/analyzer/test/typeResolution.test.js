// 步骤 3/4 的集成验证：parseComponent 接 vue-tsc 内核 → analyze 组装 PageFacts → ai 只补语义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseComponent } from '../dist/parseComponent.js'
import { createTypeResolver } from '../dist/typeResolver.js'
import { analyze, resolveComponentTypes } from '../dist/analyze.js'
import { analyzeWithAI, applyAiDescriptions, buildPrompt } from '../dist/ai.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const typedDir = path.join(here, 'fixtures', 'types')
const tsconfigPath = path.join(typedDir, 'tsconfig.json')
const factsPagePath = path.join(typedDir, 'TypeFactsPage.vue')

/** DatasourceRequest 展开形态 */
const REQUEST_SHAPE =
  '{ name: string; host: string; port?: number; status?: "active" | "disabled";' +
  ' options?: Record<string, string>; owner?: { id: number; displayName: string } }'
/** DatasourceVO 展开形态 */
const VO_SHAPE =
  '{ id: number; name: string; host: string; port: number; tags: string[]; enabled: boolean;' +
  ' status: "active" | "disabled"; kind: "mysql" | "redis"; owner: null | { id: number; displayName: string } }'
/** DatasourceFilter 展开形态 */
const FILTER_SHAPE = '{ keyword: string; datasourceType: string; status: string; testStatus: string }'
/** Partial<DatasourceFilter> 展开形态：mapped 类型让字段全变可选 */
const FILTER_PATCH_SHAPE =
  '{ keyword?: string; datasourceType?: string; status?: string; testStatus?: string }'

const factsInput = (overrides = {}) => ({
  name: 'TypeFacts',
  path: '/type-facts',
  title: '类型事实页',
  facts: {
    description: '',
    props: [{ name: 'source', type: VO_SHAPE }],
    params: [],
    events: ['submit'],
    emits: [{ name: 'submit', payloadType: `[data: ${REQUEST_SHAPE}]` }],
    exposes: [{ name: 'save', signature: `(data: ${REQUEST_SHAPE}) => Promise<${VO_SHAPE}>` }],
    ...overrides,
  },
})

test('parseComponent + vue-tsc 内核：类型写法 props / emits 载荷 / exposes 签名全部展开', () => {
  const resolver = createTypeResolver({ tsconfigPath })
  const parsed = parseComponent(factsPagePath, { resolver })

  assert.deepEqual(parsed.props, [
    { name: 'source', type: VO_SHAPE, description: '当前数据源' },
    { name: 'retry', type: 'number', description: '' },
    { name: 'filter', type: FILTER_PATCH_SHAPE, description: '过滤条件（增量）' },
    { name: 'related', type: `${VO_SHAPE}[]`, description: '关联数据源' },
  ])
  assert.deepEqual(parsed.events, [
    { name: 'submit', payloadType: `[data: ${REQUEST_SHAPE}]`, description: '提交表单' },
    { name: 'close', payloadType: VO_SHAPE, description: '' },
    { name: 'filter', payloadType: FILTER_PATCH_SHAPE, description: '' },
  ])
  assert.deepEqual(parsed.exposes[0], {
    name: 'save',
    signature: `(data: ${REQUEST_SHAPE}, dryRun?: boolean) => Promise<${VO_SHAPE}>`,
    description: '保存数据源',
  })
  // Partial<T> 这类外部泛型包装的项目内类型：按对象展开（字段变可选），不再退化成 `Partial<DatasourceFilter>`
  assert.deepEqual(parsed.exposes[1], {
    name: 'setFilter',
    signature: `(patch: ${FILTER_PATCH_SHAPE}) => Promise<${FILTER_SHAPE}>`,
    description: '设置过滤条件（增量合并），返回生效后的条件',
  })
  // 内联箭头函数：形参名 + 类型都来自 checker
  assert.equal(parsed.exposes[2].name, 'count')
  assert.equal(parsed.exposes[2].signature, '(id: number) => number')
})

test('parseComponent 不带 resolver：降级为语法级输出（名字串），不破坏老宿主', () => {
  const parsed = parseComponent(factsPagePath)

  // 类型写法拿不到展开 → 退回旧词汇表（自定义类型退化成 Object / Array）
  assert.deepEqual(parsed.props, [
    { name: 'source', type: 'Object', description: '当前数据源' },
    { name: 'retry', type: 'Number', description: '' },
    { name: 'filter', type: 'Object', description: '过滤条件（增量）' },
    { name: 'related', type: 'Array', description: '关联数据源' },
  ])
  assert.deepEqual(parsed.events, [
    { name: 'submit', payloadType: '[data: DatasourceRequest]', description: '提交表单' },
    { name: 'close', description: '' },
    { name: 'filter', description: '' },
  ])
  assert.equal(parsed.exposes[0].signature, `(data: DatasourceRequest, dryRun?: boolean) => Promise<DatasourceVO>`)
  assert.equal(parsed.exposes[1].signature, '(patch: Partial<DatasourceFilter>) => Promise<DatasourceFilter>')
})

test('resolveComponentTypes：定位 tsconfig，找不到就降级为 undefined', () => {
  assert.ok(resolveComponentTypes(typedDir), '项目根有 tsconfig.json → 建出 vue-tsc 内核')
  assert.equal(resolveComponentTypes(path.join(here, 'fixtures', 'analyze-demo')), undefined, '没 tsconfig → 降级')
  assert.ok(resolveComponentTypes('/nowhere', tsconfigPath), '显式 tsconfigPath 覆盖项目根')
})

test('analyze：manifest 的 props / emits / exposes 来自 vue-tsc 内核展开', async () => {
  const manifest = await analyze({ configPath: path.join(typedDir, 'wc.pages.json'), noAi: true })
  const page = manifest.pages.find((p) => p.tag === 'type-facts')

  assert.deepEqual(page.props, [
    { name: 'source', type: VO_SHAPE, description: '当前数据源' },
    { name: 'retry', type: 'number', description: '' },
    { name: 'filter', type: FILTER_PATCH_SHAPE, description: '过滤条件（增量）' },
    { name: 'related', type: `${VO_SHAPE}[]`, description: '关联数据源' },
  ])
  // events 仍是 runtime 监听白名单（名字数组）
  assert.deepEqual(page.events, ['submit', 'close', 'filter'])
  assert.deepEqual(page.emits, [
    { name: 'submit', payloadType: `[data: ${REQUEST_SHAPE}]`, description: '提交表单' },
    { name: 'close', payloadType: VO_SHAPE, description: '' },
    { name: 'filter', payloadType: FILTER_PATCH_SHAPE, description: '' },
  ])
  assert.equal(page.exposes[0].signature, `(data: ${REQUEST_SHAPE}, dryRun?: boolean) => Promise<${VO_SHAPE}>`)
  assert.equal(page.exposes[1].signature, `(patch: ${FILTER_PATCH_SHAPE}) => Promise<${FILTER_SHAPE}>`)
})

test('ai：buildPrompt 只喂 PageFacts（无原始源码），并只要求回语义字段', () => {
  const input = factsInput()
  const prompt = buildPrompt(input)

  assert.match(prompt, /PageFacts/)
  // 结构化 facts 原样进 prompt（字段名/类型/签名已展开）
  assert.ok(prompt.includes(JSON.stringify(input.facts, null, 2)))
  assert.match(prompt, /"propDescriptions"/)
  assert.match(prompt, /"emitDescriptions"/)
  assert.match(prompt, /"methodDescriptions"/)
  // 不再喂源码
  assert.doesNotMatch(prompt, /script setup/)
  assert.doesNotMatch(prompt, /defineExpose/)
})

test('ai：analyzeWithAI 用 facts 建 prompt、按 facts 变更失效缓存、解析补说明字段', async () => {
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                description: '数据源类型事实页',
                keywords: ['数据源'],
                exampleQueries: ['看看数据源'],
                propDescriptions: { source: '当前数据源' },
                methodDescriptions: { save: '保存' },
                emitDescriptions: { submit: '提交表单' },
              }),
            },
          },
        ],
      }),
    }
  }

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ai-'))
  const cacheFile = path.join(cacheDir, 'cache.json')
  try {
    const first = await analyzeWithAI(factsInput(), { apiKey: 'test-key', cacheFile })
    assert.equal(first.description, '数据源类型事实页')
    assert.deepEqual(first.propDescriptions, { source: '当前数据源' })
    assert.deepEqual(first.methodDescriptions, { save: '保存' })
    assert.equal(requests.length, 1)
    // prompt 里是展开后的 facts（不是原始源码）
    assert.ok(requests[0].messages[1].content.includes(JSON.stringify(factsInput().facts, null, 2)))

    // 同 path + 同 facts → 命中缓存，不再请求
    await analyzeWithAI(factsInput(), { apiKey: 'test-key', cacheFile })
    assert.equal(requests.length, 1)

    // facts 变了 → 缓存 key 变，重新请求
    const changed = factsInput({ props: [{ name: 'retry', type: 'number' }] })
    await analyzeWithAI(changed, { apiKey: 'test-key', cacheFile })
    assert.equal(requests.length, 2)
    assert.match(requests[1].messages[1].content, /"retry"/)
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('ai：applyAiDescriptions 只给缺 description 的项填空，不覆盖已有说明', () => {
  const items = [
    { name: 'a', type: 'string' },
    { name: 'b', type: 'number', description: '原有说明' },
    { name: 'c', type: 'boolean' },
  ]
  assert.deepEqual(applyAiDescriptions(items, { a: 'AI 补的', b: '不应覆盖' }), [
    { name: 'a', type: 'string', description: 'AI 补的' },
    { name: 'b', type: 'number', description: '原有说明' },
    { name: 'c', type: 'boolean' },
  ])
  // 没有 AI 结果时原样返回（保持老行为）
  assert.equal(applyAiDescriptions(items, undefined), items)
})
