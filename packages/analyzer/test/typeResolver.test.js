import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTypeResolver } from '../dist/typeResolver.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, 'fixtures', 'types')
const tsconfigPath = path.join(fixtureDir, 'tsconfig.json')
const vuePath = path.join(fixtureDir, 'TypeResolverPage.vue')
const source = fs.readFileSync(vuePath, 'utf-8')

/** fixture 里某个片段相对 .vue 文件的偏移（原始源码偏移） */
function offsetOf(needle) {
  const index = source.indexOf(needle)
  assert.notEqual(index, -1, `fixture 里应包含 ${needle}`)
  return index
}

// 期望值：跨文件把 DatasourceRequest 展开成字段结构（可选字段剥掉隐式 undefined）
const REQUEST_SHAPE =
  '{ name: string; host: string; port?: number; status?: "active" | "disabled";' +
  ' options?: Record<string, string>; owner?: { id: number; displayName: string } }'

/** DatasourceVO 展开形态（Promise<T> 的类型参数同样会展开） */
const VO_SHAPE =
  '{ id: number; name: string; host: string; port: number; tags: string[]; enabled: boolean;' +
  ' status: "active" | "disabled"; kind: "mysql" | "redis"; owner: null | { id: number; displayName: string } }'

test('typeResolver：把 .vue 里的 DatasourceRequest 展开成字段结构（跨文件类型解析）', () => {
  const resolver = createTypeResolver({ tsconfigPath })
  const annotationOffset = offsetOf('data: DatasourceRequest') + 'data: '.length

  assert.equal(resolver.serializeTypeAt(vuePath, annotationOffset), REQUEST_SHAPE)
})

test('typeResolver：exposes 函数签名展开成 (data: {...}) => Promise<...>', () => {
  const resolver = createTypeResolver({ tsconfigPath })
  const declarationOffset = offsetOf('function handleDialogSubmit')

  assert.equal(
    resolver.serializeSignatureAt(vuePath, declarationOffset),
    `(data: ${REQUEST_SHAPE}) => Promise<${VO_SHAPE}>`,
  )
})

test('typeResolver：node_modules 类型只打印名字（不递归展开）', () => {
  const resolver = createTypeResolver({ tsconfigPath })
  const annotationOffset = offsetOf('data: DatasourceRequest') + 'data: '.length

  const text = resolver.serializeTypeAt(vuePath, annotationOffset)
  // Record 来自 TS lib（node_modules）→ 保留名字；DatasourceRequest 里的项目内类型才展开
  assert.match(text, /options\?: Record<string, string>/)
  assert.match(text, /owner\?: \{ id: number; displayName: string \}/)
})

test('typeResolver：原文偏移能映射到虚拟 TS，且映射不上的偏移降级为 undefined', () => {
  const resolver = createTypeResolver({ tsconfigPath })
  const annotationOffset = offsetOf('data: DatasourceRequest')

  // .vue 已在 program 里（作为虚拟 TS），映射到有效偏移
  const programOffset = resolver.toProgramOffset(vuePath, annotationOffset)
  assert.equal(typeof programOffset, 'number')
  assert.ok(programOffset > source.length, '虚拟 TS 把原文空格化后拼接，脚本内容整体后移')

  // 模板区（<div>）在脚本虚拟码之外 → 映射不上，调用方降级回 babel 的名字串
  assert.equal(resolver.serializeTypeAt(vuePath, offsetOf('<div>')), undefined)

  // 不在 program 里的文件 → 返回 undefined
  assert.equal(resolver.getSourceFile(path.join(fixtureDir, 'datasource.ts')) !== undefined, true)
  assert.equal(resolver.serializeTypeAt(path.join(fixtureDir, 'missing.vue'), 0), undefined)
})

/* -------------------------------------------------------------------------- */
/* 外部泛型包装的项目内类型（Partial<T> / Promise<T> / Foo[]）                    */
/* -------------------------------------------------------------------------- */

const factsPath = path.join(fixtureDir, 'TypeFactsPage.vue')
const factsSource = fs.readFileSync(factsPath, 'utf-8')

/** TypeFactsPage 里某个片段相对 .vue 文件的偏移 */
function factsOffsetOf(needle) {
  const index = factsSource.indexOf(needle)
  assert.notEqual(index, -1, `fixture 里应包含 ${needle}`)
  return index
}

test('typeResolver：Partial<T> 只认名字，类型参数里的项目内类型按对象展开（字段变可选）', () => {
  const resolver = createTypeResolver({ tsconfigPath })
  // parseComponent 传来的就是注解起点（`Partial` 的位置）——这正是以前退化成 `Partial<T>` 的那个偏移
  const offset = factsOffsetOf('filter?: Partial<DatasourceFilter>') + 'filter?: '.length

  assert.equal(
    resolver.serializeTypeAt(factsPath, offset),
    '{ keyword?: string; datasourceType?: string; status?: string; testStatus?: string }',
  )
})

test('typeResolver：数组注解保留 []（偏移落在元素类型名上也不退化成元素类型）', () => {
  const resolver = createTypeResolver({ tsconfigPath })
  const offset = factsOffsetOf('related?: DatasourceVO[]') + 'related?: '.length

  assert.equal(resolver.serializeTypeAt(factsPath, offset), `${VO_SHAPE}[]`)
})

test('typeResolver：外部泛型 Promise<T> 保留名字，类型参数继续展开', () => {
  const resolver = createTypeResolver({ tsconfigPath })
  const offset = factsOffsetOf('save, setFilter') + 'save, '.length
  const signature = resolver.serializeSignatureAt(factsPath, offset)

  assert.match(signature, /^\(patch: \{ keyword\?: string;/)
  assert.match(signature, /\}\) => Promise<\{ keyword: string;/)
})
