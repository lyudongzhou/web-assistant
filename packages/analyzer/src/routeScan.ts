// 路由入参探测：找出「页面到底读哪些路由入参」—— 尤其是不在 path 里的 `route.query.x`。
//
// 为什么需要它：analyzer 原来只看 wc.pages.json 的 path 正则（`:param`），于是页面写
// `const ruleName = computed(() => String(route.query.name || ''))` 时 manifest 的 params 为空，
// agent 永远不知道该传什么；而 vue-router 又会**丢弃** path 里没声明的 params —— 路径外的键值
// 只能通过 query 通道送达（openspec change `detect-route-query-params`）。所以本模块把「通道」
// 探测出来，写进 `manifest.pages[].params[].in`。
//
// 识别范围（纯静态 AST + 模板正则，不执行页面代码、不依赖 vue-tsc）：
//   - `const route = useRoute()`      → route.query.x / route.query['x'] / route.query[`x`]
//   - `const { query } = useRoute()`  → query.x（含 `{ query: q }` 别名）
//   - `const { x } = route.query`     → 解构键（含 `{ x: alias }` 重命名）
//   - `const q = route.query`         → q.x（别名）
//   - `useRoute().query.x`            → 内联调用
//   - 模板里的 `$route.query.x` / `<已绑定的 route 变量>.query.x`
//   同理记录 `route.params.x` 的读取（`paramReads`），用于与 path 对账
//
// 类型推断优先级：同名 `defineProps` 的类型 > 使用点的包装调用（String/Number/Boolean/parseInt…）
// > 兜底字面量（`|| 1`） > 恒等比较（`=== 'true'`） > 缺省 string。
//
// 读不出来的情形（动态键 / 整块读 / 跨文件封装了 useRoute）**不猜**，只出诊断 ——
// 由 wc.pages.json 页面条目的显式 `query` 声明兜底（单一真相来源不变）。
import fs from 'node:fs'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseScript } from '@babel/parser'
import type { ManifestParam, ManifestProp } from '@webassistant/protocol'
import { extractParams, leadingComment } from './parseComponent.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = Record<string, any>

const COERCE_TYPES: Record<string, string> = {
  String: 'string',
  Number: 'number',
  parseInt: 'number',
  parseFloat: 'number',
  Boolean: 'boolean',
}

/** 类型证据可以「穿过」的父节点（不改写证据语义） */
const TRANSPARENT = new Set([
  'LogicalExpression',
  'BinaryExpression',
  'ConditionalExpression',
  'TemplateLiteral',
  'TSAsExpression',
  'TSNonNullExpression',
  'ParenthesizedExpression',
  'ArrowFunctionExpression',
  'ReturnStatement',
  'ObjectProperty',
  'Property',
  'ExpressionStatement',
])

/** 查询参数的类型证据（逐项构造，最后按优先级取值） */
interface Evidence {
  /** 包装调用：Number(...) / String(...) */
  coerceType?: string
  /** 兜底字面量：route.query.page || 1 */
  defaultType?: string
  /** route.query.flag === 'true' */
  boolCompare?: boolean
}

interface Hit extends Evidence {
  name: string
  order: number
  description: string
}

export interface RouteAccessFacts {
  /** 源码里读到的 query 键（首次出现顺序、已按名去重，通道固定 query） */
  queries: ManifestParam[]
  /** 源码里读到的 `route.params.X` 名字（与 path 段对账用） */
  paramReads: string[]
  /** 无法枚举 / 无法交付的诊断，由调用方打印 */
  warnings: string[]
}

export interface ScanRouteAccessOptions {
  /** 页面已解析出的 props：同名参数直接复用 props 的类型与说明 */
  props?: ManifestProp[]
}

export interface ResolvePageParamsOptions extends ScanRouteAccessOptions {
  /**
   * wc.pages.json 页面条目的显式 query 声明（与探测同名同通道时以显式为准）。
   *
   * 通道固定为 `query`，所以这里用 `Omit<ManifestParam, 'in'>`：声明里写 `in` 没有意义
   * （会被装配时覆盖），类型上直接禁掉，避免「写了 in: 'path' 却被悄悄改成 query」。
   */
  explicit?: Array<Omit<ManifestParam, 'in'>>
}

export interface ResolvedPageParams {
  params: ManifestParam[]
  warnings: string[]
}

export function scanRouteAccess(filePath: string, options: ScanRouteAccessOptions = {}): RouteAccessFacts {
  const empty: RouteAccessFacts = { queries: [], paramReads: [], warnings: [] }
  let code: string
  try {
    code = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return empty
  }

  const collector = new RouteAccessCollector(options.props ?? [])
  const isSfc = /\.vue$/i.test(filePath)
  if (isSfc) {
    const { descriptor, errors } = parseSfc(code, { filename: filePath })
    if (errors?.length) {
      return { ...empty, warnings: [`SFC 解析失败：${String(errors[0]?.message ?? errors[0])}`] }
    }
    const block = descriptor.scriptSetup ?? descriptor.script
    if (!block) return empty
    collector.collectScriptBlock(block.content, block.lang)
    if (descriptor.template?.content) collector.collectTemplate(descriptor.template.content)
  } else {
    // 非 .vue 页面（react 批次的 .tsx / 普通 .ts）：整份文件就是脚本
    collector.collectScriptBlock(code, /\.[jt]sx$/i.test(filePath) ? 'tsx' : 'ts')
  }
  return collector.finish()
}

/**
 * 唯一的「页面入参」装配入口（analyzer 与 vite-plugin-wc 共用）：
 * path 正则 + 源码探测的 query + wc.pages.json 的显式声明，按 `(name, in)` 去重合并，
 * 并给出「读得到但送不到」的诊断。
 */
export function resolvePageParams(
  routePath: string,
  componentPath: string | null,
  options: ResolvePageParamsOptions = {},
): ResolvedPageParams {
  const pathParams = extractParams(routePath)
  const scanned = componentPath ? scanRouteAccess(componentPath, options) : { queries: [], paramReads: [], warnings: [] }

  const params: ManifestParam[] = []
  const index = new Map<string, number>()
  const push = (param: ManifestParam): void => {
    const key = `${param.in ?? 'path'}::${param.name}`
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, params.length)
      params.push(param)
      return
    }
    // 同名同通道：显式声明覆盖探测/正则结果（类型与说明以显式为准）
    params[at] = { ...params[at], ...param }
  }

  for (const param of pathParams) push(param)
  for (const param of scanned.queries) push(param)
  for (const explicit of options.explicit ?? []) push({ ...explicit, in: 'query' })

  const warnings = [...scanned.warnings]
  const declaredPath = new Set(pathParams.map((param) => param.name))
  for (const read of scanned.paramReads) {
    if (declaredPath.has(read)) continue
    warnings.push(
      `页面读 route.params.${read}，但清单里的 path「${routePath}」没有 :${read} —— ` +
        'vue-router 会丢弃这种参数（Discarded invalid param）；请改 path 补 :' +
        `${read}，或页面改读 route.query.${read}。`,
    )
  }
  // 显式声明与 path 段同名：会同时下发 path 与 query 两条同名入参（同名双通道本身是合法能力，
  // 但通常是无意为之，所以提醒一次 —— 清单里的 `query` 是逃生口，不是「再来一份 path 参数」）。
  for (const explicit of options.explicit ?? []) {
    if (!declaredPath.has(explicit.name)) continue
    warnings.push(
      `清单在页面条目的 query 里声明了「${explicit.name}」，但 path「${routePath}」里已有 :${explicit.name} —— ` +
        '会同时下发 path 与 query 两条同名入参；只想保留一条时请去掉其中一处。',
    )
  }
  return { params, warnings }
}

/** 收集器：两遍扫描（先建绑定表，再找访问点），避免依赖语句顺序 */
class RouteAccessCollector {
  /** `useRoute()` 的绑定名 */
  private readonly routeVars = new Set<string>()
  /** 路由 query 对象的绑定名（`const { query } = useRoute()` / `const q = route.query`） */
  private readonly queryVars = new Set<string>()
  /** 路由 params 对象的绑定名（`const { params } = useRoute()` / `const p = route.params`） */
  private readonly paramVars = new Set<string>()
  private readonly hits = new Map<string, Hit>()
  private readonly paramReads = new Set<string>()
  private readonly warnings = new Set<string>()
  private order = 0

  constructor(private readonly props: readonly ManifestProp[]) {}

  collectScriptBlock(content: string, lang?: string): void {
    const isTs = lang === 'ts' || lang === 'tsx'
    let program: AnyNode
    try {
      program = parseScript(content, {
        sourceType: 'module',
        plugins: isTs ? ['typescript'] : [],
      }).program as unknown as AnyNode
    } catch (cause) {
      this.warn(`页面源码解析失败，跳过路由入参探测：${(cause as Error).message}`)
      return
    }
    const body = (program.body ?? []) as AnyNode[]
    // 单遍：DFS 先访问声明节点（bind）再访问其子表达式（access）→ hits 顺序 = 源码里首次被读到的顺序。
    // 前提是「绑定先于使用」（`const route = useRoute()` 在读取之前），与 <script setup> 的常规写法一致。
    for (const statement of body) {
      this.walk(statement, null, (node) => {
        this.bind(node)
        this.access(node)
      })
    }
  }

  /** 模板块：只认 `$route` 与脚本里已绑定的路由变量名，避免误报无关的 `.query.` */
  collectTemplate(content: string): void {
    const owners = ['$route', ...this.routeVars].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const owner = `(?:\\$route|${owners.filter((name) => name !== '\\$route').join('|') || '(?!)'})`
    const keyRe = new RegExp(
      `${owner}\\s*\\.\\s*query\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*['"]([^'"]+)['"]\\s*\\])`,
      'g',
    )
    for (const match of content.matchAll(keyRe)) {
      const name = match[1] ?? match[2]
      if (name) this.recordHit(name, undefined)
    }
    const paramRe = new RegExp(`${owner}\\s*\\.\\s*params\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
    for (const match of content.matchAll(paramRe)) this.paramReads.add(match[1])
  }

  finish(): RouteAccessFacts {
    const queries = [...this.hits.values()]
      .sort((a, b) => a.order - b.order)
      .map((hit) => this.toParam(hit))
    return {
      queries,
      paramReads: [...this.paramReads],
      warnings: [...this.warnings],
    }
  }

  // ------------------------------------------------------------ 内部

  private toParam(hit: Hit): ManifestParam {
    const prop = this.props.find((item) => item.name === hit.name)
    const param: ManifestParam = { name: hit.name, type: resolveType(hit, prop), in: 'query' }
    const description = hit.description || prop?.description
    if (description) param.description = description
    return param
  }

  private warn(message: string): void {
    this.warnings.add(message)
  }

  /** 深度优先遍历 + 挂 `__parent`（babel 节点默认无父指针，类型证据要向上找） */
  private walk(node: AnyNode | null | undefined, parent: AnyNode | null, visit: (node: AnyNode) => void): void {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) this.walk(child, parent, visit)
      return
    }
    if (typeof node.type !== 'string') return
    node.__parent = parent
    visit(node)
    for (const key of Object.keys(node)) {
      if (key === '__parent' || key === 'loc' || key.endsWith('Comments')) continue
      this.walk(node[key], node, visit)
    }
  }

  /** 第一遍：绑定表（route / query / params 别名） */
  private bind(node: AnyNode): void {
    if (node.type !== 'VariableDeclarator' || !node.id || !node.init) return
    const { id, init } = node as { id: AnyNode; init: AnyNode }
    if (init.type === 'CallExpression' && calleeName(init) === 'useRoute') {
      if (id.type === 'Identifier') this.routeVars.add(id.name)
      else if (id.type === 'ObjectPattern') {
        for (const prop of (id.properties ?? []) as AnyNode[]) this.bindRoutePattern(prop)
      }
      return
    }
    if (this.isRouteObject(init, 'query')) {
      if (id.type === 'Identifier') this.queryVars.add(id.name)
      else if (id.type === 'ObjectPattern') this.readPatternKeys(id, node, 'query')
      return
    }
    if (this.isRouteObject(init, 'params')) {
      if (id.type === 'Identifier') this.paramVars.add(id.name)
      else if (id.type === 'ObjectPattern') this.readPatternKeys(id, node, 'params')
    }
  }

  /** `const { query } = useRoute()` / `const { params: p } = useRoute()` */
  private bindRoutePattern(prop: AnyNode): void {
    if (prop.type !== 'ObjectProperty' || prop.computed) return
    const value = prop.value
    const local = value?.type === 'AssignmentPattern' ? value.left : value
    if (local?.type !== 'Identifier') return
    if (prop.key?.name === 'query') this.queryVars.add(local.name)
    else if (prop.key?.name === 'params') this.paramVars.add(local.name)
  }

  /** `const { name } = route.query` / `const { name: ruleName } = route.query` */
  private readPatternKeys(pattern: AnyNode, declarator: AnyNode, channel: 'query' | 'params'): void {
    for (const prop of (pattern.properties ?? []) as AnyNode[]) {
      if (prop.type === 'RestElement') {
        this.warn(
          `页面用剩余属性读 route.${channel}（无法枚举键）—— ` +
            (channel === 'query'
              ? '请在 wc.pages.json 的页面条目用 query 显式声明这些键。'
              : '走 path 请先在清单的 path 里补 :段位；否则让页面改读 route.query.x，并在页面条目的 query 里声明。'),
        )
        continue
      }
      if (prop.type !== 'ObjectProperty') continue
      const key = propertyKeyName(prop)
      if (!key) continue
      if (channel === 'query') this.recordHit(key, undefined, declarator)
      else this.paramReads.add(key)
    }
  }

  /** 第二遍：访问点 */
  private access(node: AnyNode): void {
    if (node.type !== 'MemberExpression') return
    const object = node.object

    // route.query.x / route.query['x'] / route.query[key]
    if (this.isRouteObject(node, 'query') && !this.isKeyedAccess(node) && !this.isDeclaratorInit(node)) {
      this.warn('页面整块读取 route.query（无法枚举键）—— 请在 wc.pages.json 的页面条目用 query 显式声明这些键。')
      return
    }
    if (object?.type === 'Identifier' && this.queryVars.has(object.name)) {
      this.readMember(node, 'query')
      return
    }
    if (object && this.isRouteObject(object, 'query')) {
      this.readMember(node, 'query')
      return
    }
    if (object && this.isRouteObject(object, 'params')) {
      this.readMember(node, 'params')
      return
    }
    if (object?.type === 'Identifier' && this.paramVars.has(object.name)) {
      this.readMember(node, 'params')
    }
  }

  /** `X.name` / `X['name']` / `X[key]` 的读取（X 是 query / params 对象） */
  private readMember(node: AnyNode, channel: 'query' | 'params'): void {
    const parent = node.__parent as AnyNode | null
    // `route.query` / `route.params` 作为对象本身被用于别处（解构 / 别名 / 整块读）
    if (parent?.type === 'VariableDeclarator' && parent.init === node) return
    if (!node.computed && node.property?.type === 'Identifier') {
      if (channel === 'query') this.recordHit(node.property.name, node)
      else this.paramReads.add(node.property.name)
      return
    }
    if (!node.computed) return
    const key = literalKey(node.property)
    if (key) {
      if (channel === 'query') this.recordHit(key, node)
      else this.paramReads.add(key)
      return
    }
    this.warn(
      `页面用动态键读 route.${channel}（无法枚举键）—— ` +
        (channel === 'query'
          ? '请在 wc.pages.json 的页面条目用 query 显式声明这些键。'
          : '走 path 请先在清单的 path 里补 :段位；否则让页面改读 route.query.x，并在页面条目的 query 里声明。'),
    )
  }

  /** 该表达式是否路由对象（route.query / useRoute().query / 别名） */
  private isRouteObject(node: AnyNode | undefined, prop: 'query' | 'params'): boolean {
    if (node?.type !== 'MemberExpression' || node.computed) return false
    if (node.property?.name !== prop) return false
    const object = node.object
    if (object?.type === 'CallExpression') return calleeName(object) === 'useRoute'
    if (object?.type === 'Identifier') {
      if (this.routeVars.has(object.name)) return true
      if (prop === 'query' && this.queryVars.has(object.name)) return true
      if (prop === 'params' && this.paramVars.has(object.name)) return true
    }
    return false
  }

  /** `route.query.x` 形态：只要父节点把它当对象再取成员 */
  private isKeyedAccess(node: AnyNode): boolean {
    const parent = node.__parent as AnyNode | null
    return parent?.type === 'MemberExpression' && parent.object === node
  }

  /** 解构 / 起别名（`const { x } = route.query` / `const q = route.query`）：bind 已处理，不是「整块读」 */
  private isDeclaratorInit(node: AnyNode): boolean {
    const parent = node.__parent as AnyNode | null
    return parent?.type === 'VariableDeclarator' && parent.init === node
  }

  private recordHit(name: string, node?: AnyNode, declarator?: AnyNode): void {
    let hit = this.hits.get(name)
    if (!hit) {
      hit = { name, order: this.order, description: '' }
      this.order += 1
      this.hits.set(name, hit)
    }
    if (node) inferEvidence(node, hit)
    if (declarator && !hit.description) {
      const description = commentOfDeclaration(declarator)
      if (description) hit.description = description
    }
  }
}

/** 声明处注释：注释挂在 declarator 或其父 VariableDeclaration 上（babel 两种都可能） */
function commentOfDeclaration(node: AnyNode): string {
  if (node.type === 'VariableDeclaration') {
    return firstLine(leadingComment(node) || leadingComment(node.declarations?.[0] ?? {}))
  }
  return firstLine(leadingComment(node) || leadingComment((node.__parent as AnyNode) ?? {}))
}

/**
 * 只取注释的第一行 —— query 参数的 description 会进 manifest、进而进 agent 的 system prompt，
 * 多行 JSDoc 的续行往往是开发者向的补充说明（"清单声明可选"之类），不该出网。
 * 想写更完整的业务口径，用 wc.pages.json 页面条目的 `query` 声明覆盖（显式优先）。
 */
function firstLine(text: string): string {
  return text.split('\n')[0].trim()
}

/** 类型定稿：props 声明 > 包装调用 > 兜底字面量 > 恒等比较 > string */
function resolveType(hit: Hit, prop: ManifestProp | undefined): string {
  if (prop?.type) return prop.type
  if (hit.coerceType) return hit.coerceType
  if (hit.defaultType) return hit.defaultType
  if (hit.boolCompare) return 'boolean'
  return 'string'
}

/** 从使用点向上收集类型证据与就近 JSDoc（预算 6 层，避免把不相关的祖先算进来） */
function inferEvidence(node: AnyNode, hit: Hit): void {
  let child: AnyNode = node
  let parent = node.__parent as AnyNode | null
  for (let depth = 0; parent && depth < 6; depth += 1) {
    const current = parent
    if (current.type === 'VariableDeclarator' || current.type === 'VariableDeclaration') {
      const description = commentOfDeclaration(current)
      if (description && !hit.description) hit.description = description
      return
    }
    if (current.type === 'CallExpression' && (current.arguments ?? []).includes(child)) {
      const type = COERCE_TYPES[calleeName(current) ?? '']
      if (type) hit.coerceType = type
    } else if (current.type === 'LogicalExpression' && current.left === child) {
      const type = literalType(current.right)
      if (type && !hit.defaultType) hit.defaultType = type
    } else if (
      current.type === 'BinaryExpression' &&
      (current.operator === '===' || current.operator === '==') &&
      current.left === child
    ) {
      const other = current.right
      if (other?.type === 'StringLiteral' && (other.value === 'true' || other.value === 'false')) {
        hit.boolCompare = true
      }
    } else if (current.type === 'UnaryExpression' && current.operator === '+' && current.argument === child) {
      hit.coerceType = 'number'
    } else if (!TRANSPARENT.has(current.type)) {
      return
    }
    child = current
    parent = current.__parent as AnyNode | null
  }
}

function literalType(node: AnyNode | undefined): string | undefined {
  switch (node?.type) {
    case 'NumericLiteral':
      return 'number'
    case 'StringLiteral':
      return 'string'
    case 'BooleanLiteral':
      return 'boolean'
    case 'ArrayExpression':
      return 'array'
    case 'NullLiteral':
      return undefined
    default:
      return undefined
  }
}

/** 对象属性名（`{ keyword: kw }` 是 Identifier，`{ 'a-b': x }` 是字面量；计算属性名无法枚举） */
function propertyKeyName(prop: AnyNode): string | undefined {
  if (prop.computed) return undefined
  if (prop.key?.type === 'Identifier') return prop.key.name
  return literalKey(prop.key)
}

/** 静态键：字符串 / 数字字面量、无插值的模板字符串 */
function literalKey(node: AnyNode | undefined): string | undefined {
  if (!node) return undefined
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return String(node.value)
  if (node.type === 'TemplateLiteral' && !(node.expressions ?? []).length) {
    return node.quasis?.[0]?.value?.cooked ?? undefined
  }
  return undefined
}

function calleeName(call: AnyNode): string | undefined {
  const callee = call?.callee
  if (!callee) return undefined
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed) return callee.property?.name
  return undefined
}
