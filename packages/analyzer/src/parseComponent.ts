// 解析页面组件，提取 manifest 需要的静态信息：
// - description：<!-- @description ... --> 或 /* @description ... */
// - props：defineProps 的运行时对象写法（可从行注释拿 description）与类型写法（typeResolver 在时展开成字段结构）
// - events：defineEmits 的数组/对象/类型写法（含 payload 类型作为 signature）
// - exposes：defineExpose({...}) 静态对象写法取 key 列表 + 行注释作 description
//
// 用 @vue/compiler-sfc 切 SFC 块（而不是正则），并给 babel 开 typescript 插件 ——
// 页面一旦写成 <script setup lang="ts">，不开插件会直接抛错。
//
// 分工（design D1）：babel 负责「找到 defineXxx + 拿 JSDoc 描述」，类型定稿交给 typeResolver。
// 传了 `options.resolver`（vue-tsc 内核）时，类型写法 props / emits 载荷 / exposes 签名里的
// 自定义类型会展开成真实字段结构；没传或解析不出时保持原来的语法级输出（design D3，不改老宿主表现）。
import fs from 'node:fs'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseScript } from '@babel/parser'
import type { ManifestEvent, ManifestMethod, ManifestParam, ManifestProp } from '@webassistant/protocol'
import type { TypeResolver } from './typeResolver.js'

export interface ParsedComponent {
  description: string
  props: ManifestProp[]
  events: ManifestEvent[]
  exposes: ManifestMethod[]
}

export interface ParseComponentOptions {
  /** vue-tsc 内核类型解析器；缺省则只做语法级解析（不展开自定义类型） */
  resolver?: TypeResolver
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = Record<string, any>

/** babel 节点 → 真实类型的展开入口：把「脚本内偏移」换算成「.vue 文件偏移」后交给 typeResolver */
interface ExpandContext {
  resolver?: TypeResolver
  filePath: string
  /** <script setup> 内容在 .vue 文件里的起始偏移 */
  blockOffset: number
  /** 节点类型 → 展开文本；没有 resolver / 不是 TS 节点 / 解析不出时返回 undefined */
  typeText(node: AnyNode | undefined): string | undefined
  /** 节点函数签名 → 展开文本 */
  signatureText(node: AnyNode | undefined): string | undefined
}

function createExpandContext(
  resolver: TypeResolver | undefined,
  filePath: string,
  blockOffset: number,
): ExpandContext {
  const at = (node: AnyNode | undefined, serialize: (offset: number) => string | undefined) => {
    if (!resolver || !node || typeof node.start !== 'number') return undefined
    return serialize(blockOffset + node.start)
  }
  return {
    resolver,
    filePath,
    blockOffset,
    typeText: (node) => at(node, (offset) => resolver!.serializeTypeAt(filePath, offset)),
    signatureText: (node) => at(node, (offset) => resolver!.serializeSignatureAt(filePath, offset)),
  }
}

export function parseComponent(filePath: string, options: ParseComponentOptions = {}): ParsedComponent {
  const code = fs.readFileSync(filePath, 'utf-8')
  const description = extractDescription(code)
  const props: ManifestProp[] = []
  const events: ManifestEvent[] = []
  const exposes: ManifestMethod[] = []

  const { descriptor } = parseSfc(code, { filename: filePath })
  const block = descriptor.scriptSetup ?? descriptor.script
  if (!block) return { description, props, events, exposes }

  const isTs = block.lang === 'ts' || block.lang === 'tsx'
  const ast = parseScript(block.content, {
    sourceType: 'module',
    plugins: isTs ? ['typescript'] : [],
  })

  const ctx = createExpandContext(options.resolver, filePath, block.loc.start.offset)

  // <script setup> 里的 defineProps/defineEmits/defineExpose 一定是顶层语句，浅扫即可（省掉 @babel/traverse 依赖）
  const body = ast.program.body as unknown as AnyNode[]
  // defineExpose({ refresh }) 常写成「引用已声明的函数」，先把顶层函数签名/JSDoc 收进表里，
  // 标识符引用时回查，避免 expose 的 signature 退化成裸名字。
  const localFns = collectLocalFunctions(body)
  for (const statement of body) {
    for (const call of collectTopLevelCalls(statement)) {
      const callee = call.callee as AnyNode
      const name = callee?.name ?? callee?.property?.name
      if (name === 'defineProps') extractProps(call, props, ctx)
      else if (name === 'defineEmits') extractEmits(call, events, ctx)
      else if (name === 'defineExpose') extractExpose(call, exposes, localFns, ctx)
    }
  }
  return { description, props, events, exposes }
}

/** 从顶层语句里挖出 CallExpression：直接调用、赋值给变量、await / as 包一层 */
function collectTopLevelCalls(statement: AnyNode): AnyNode[] {
  const out: AnyNode[] = []
  const visit = (node: AnyNode | null | undefined): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      out.push(node)
      return
    }
    if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression') visit(node.expression)
    if (node.type === 'AwaitExpression') visit(node.argument)
  }
  if (statement.type === 'ExpressionStatement') visit(statement.expression)
  if (statement.type === 'VariableDeclaration') {
    for (const decl of (statement.declarations ?? []) as AnyNode[]) visit(decl.init)
  }
  return out
}

function extractDescription(code: string): string {
  const matched =
    code.match(/<!--\s*@description\s*([\s\S]*?)\s*-->/)?.[1] ??
    code.match(/\/\*\s*@description\s*([\s\S]*?)\s*\*\//)?.[1]
  return matched ? matched.trim() : ''
}

function leadingComment(node: AnyNode): string {
  const comments = (node.leadingComments ?? []) as Array<{ value: string }>
  if (!comments.length) return ''
  // 「就近」语义：只取紧贴声明的最后一条注释 —— 上方的分区注释（// —— xxx ——）不算描述
  const last = comments[comments.length - 1]
  return last.value
    .trim()
    // 头部去注释起始符（@ * / 空白），尾部去 JSDoc 收尾残留的 * / 空白
    .replace(/^[@*/\s]+/, '')
    .replace(/[\s*/]+$/, '')
    .trim()
}

/** 从路由 path 提取参数：/users/:id → [{ name:'id', type:'string' }] */
export function extractParams(routePath: string): ManifestParam[] {
  const out: ManifestParam[] = []
  for (const match of routePath.matchAll(/:([A-Za-z0-9_]+)/g)) {
    out.push({ name: match[1], type: 'string' })
  }
  return out
}

function extractProps(call: AnyNode, props: ManifestProp[], ctx: ExpandContext): void {
  // 运行时写法：defineProps({ users: { type: Array, ... } }) —— 能从行注释拿 description
  const arg = (call.arguments ?? [])[0] as AnyNode | undefined
  if (arg?.type === 'ObjectExpression') {
    for (const prop of arg.properties as AnyNode[]) {
      if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue
      const name = prop.key?.name ?? prop.key?.value
      if (!name) continue
      let type = 'Any'
      if (prop.value?.type === 'ObjectExpression') {
        for (const inner of prop.value.properties as AnyNode[]) {
          const key = inner.key?.name ?? inner.key?.value
          if (key !== 'type') continue
          // Array as PropType<User[]> —— TS 写法会包一层 TSAsExpression，要剥掉才能拿到构造器名
          const value = inner.value?.type === 'TSAsExpression' ? inner.value.expression : inner.value
          if (value?.type === 'Identifier') type = value.name
        }
      } else if (prop.value?.type === 'Identifier') {
        type = prop.value.name
      }
      props.push({ name: String(name), type, description: leadingComment(prop) })
    }
    return
  }
  // 类型写法：defineProps<{ user?: UserVO }>()
  // 有 typeResolver 时把注解类型展开（UserVO → { ...字段 }）；拿不到展开文本时退回语法级名字。
  const typeArgs = (call.typeParameters ?? call.typeArguments) as AnyNode | undefined
  const literal = (typeArgs?.params ?? [])[0] as AnyNode | undefined
  if (literal?.type !== 'TSTypeLiteral') return
  for (const member of literal.members as AnyNode[]) {
    if (member.type !== 'TSPropertySignature') continue
    const name = member.key?.name ?? member.key?.value
    if (!name) continue
    const annotation = member.typeAnnotation?.typeAnnotation
    props.push({
      name: String(name),
      type: ctx.typeText(annotation) ?? tsTypeName(annotation),
      description: leadingComment(member),
    })
  }
}

function tsTypeName(node: AnyNode | undefined): string {
  if (!node) return 'Any'
  switch (node.type) {
    case 'TSStringKeyword':
      return 'String'
    case 'TSNumberKeyword':
      return 'Number'
    case 'TSBooleanKeyword':
      return 'Boolean'
    case 'TSArrayType':
      return 'Array'
    case 'TSTypeLiteral':
      return 'Object'
    case 'TSTypeReference': {
      const name = String(node.typeName?.name ?? 'Object')
      if (name === 'Array') return 'Array'
      return ['String', 'Number', 'Boolean'].includes(name) ? name : 'Object'
    }
    case 'TSUnionType': {
      const types = (node.types ?? []) as AnyNode[]
      const first = types.find((t) => t.type !== 'TSUndefinedKeyword' && t.type !== 'TSNullKeyword')
      return tsTypeName(first)
    }
    default:
      return 'Any'
  }
}

function extractEmits(call: AnyNode, events: ManifestEvent[], ctx: ExpandContext): void {
  const arg = (call.arguments ?? [])[0] as AnyNode | undefined
  if (arg?.type === 'ArrayExpression') {
    for (const element of arg.elements as AnyNode[]) {
      if (element?.type === 'StringLiteral') events.push({ name: element.value })
    }
    return
  }
  if (arg?.type === 'ObjectExpression') {
    for (const prop of arg.properties as AnyNode[]) {
      const name = prop.key?.name ?? prop.key?.value
      if (name) events.push({ name: String(name), description: leadingComment(prop) })
    }
    return
  }
  // 类型写法：defineEmits<{ save: [p: Foo] }>() 或 { (e: 'save', v: Foo): void }
  const typeArgs = (call.typeParameters ?? call.typeArguments) as AnyNode | undefined
  const literal = (typeArgs?.params ?? [])[0] as AnyNode | undefined
  if (literal?.type !== 'TSTypeLiteral') return
  for (const member of literal.members as AnyNode[]) {
    if (member.type === 'TSPropertySignature') {
      const name = member.key?.name ?? member.key?.value
      if (!name) continue
      // 序列号元组类型 'save: [p: Foo]' → '[p: Foo]'（元素类型有 resolver 时展开成字段结构）
      const tuple = member.typeAnnotation?.typeAnnotation
      const payloadType = tuple?.type === 'TSTupleType' ? serializeTupleType(tuple, ctx) : undefined
      events.push({
        name: String(name),
        ...(payloadType ? { payloadType } : {}),
        description: leadingComment(member),
      })
      continue
    }
    if (member.type === 'TSCallSignatureDeclaration') {
      const params = (member.parameters ?? []) as AnyNode[]
      const value = params[0]?.typeAnnotation?.typeAnnotation?.literal?.value
      if (typeof value !== 'string') continue
      // (e: 'view', v: Payload) —— 第二个形参是载荷类型
      const payloadType = ctx.typeText(params[1]?.typeAnnotation?.typeAnnotation)
      events.push({
        name: value,
        ...(payloadType ? { payloadType } : {}),
        description: leadingComment(member),
      })
    }
  }
}

/**
 * 解析 defineExpose({ refresh, setKeyword })
 * 静态对象写法取 key 列表（Identifier / StringLiteral），SpreadElement 跳过；
 * 行注释作 description。TS 泛型写法 defineExpose<T>() 暂不支持（罕见、收益小）。
 */
function extractExpose(call: AnyNode, exposes: ManifestMethod[], localFns: Map<string, LocalFn>, ctx: ExpandContext): void {
  const arg = (call.arguments ?? [])[0] as AnyNode | undefined
  if (arg?.type !== 'ObjectExpression') return
  for (const prop of arg.properties as AnyNode[]) {
    if (!prop) continue
    if (prop.type === 'SpreadElement') continue
    const name = prop.key?.name ?? prop.key?.value
    if (!name) continue
    // 值为标识符时（defineExpose({ refresh })），签名与 JSDoc 回到顶层声明处取
    const local = prop.value?.type === 'Identifier' ? localFns.get(String(prop.value.name)) : undefined
    const description = leadingComment(prop) || local?.description || ''
    exposes.push({
      name: String(name),
      // 有 typeResolver 时直接用 checker 定函数签名（自定义类型会展开，import 来的函数也认）；
      // 否则回退到顶层函数表 / 内联箭头函数的语法级签名。
      signature: ctx.signatureText(prop.value) ?? serializeFunctionType(prop.value, localFns),
      description: description || undefined,
    })
  }
}

/** 顶层函数登记：function foo(){} / const foo = () => {} → { signature, description } */
interface LocalFn {
  signature?: string
  description?: string
}

function collectLocalFunctions(body: AnyNode[]): Map<string, LocalFn> {
  const out = new Map<string, LocalFn>()
  const register = (name: AnyNode | undefined, init: AnyNode | undefined, commentNode?: AnyNode): void => {
    const signature = serializeFunctionType(init)
    const commentSource = commentNode ?? init
    const description = commentSource ? leadingComment(commentSource) : ''
    if (signature || description) out.set(String(name), { signature, description: description || undefined })
  }
  for (const statement of body) {
    if (statement.type === 'FunctionDeclaration' && statement.id?.name) {
      register(statement.id.name, statement)
      continue
    }
    if (statement.type === 'VariableDeclaration') {
      const decls = (statement.declarations ?? []) as AnyNode[]
      // 单声明时 JSDoc 挂在声明语句上；多声明无法归属，忽略 description
      const commentNode = decls.length === 1 ? statement : undefined
      for (const decl of decls) {
        if (decl.id?.type !== 'Identifier') continue
        register(decl.id.name, decl.init, commentNode)
      }
    }
  }
  return out
}

/** 序列化函数签名：`(p: Foo, q?: Bar) => number` 形式，仅给 agent 看个大概 */
function serializeFunctionType(node: AnyNode | undefined, localFns?: Map<string, LocalFn>): string | undefined {
  if (!node) return undefined
  // function / arrow function 声明或表达式：直接看 params 与返回类型
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') {
    const params = (node.params ?? []) as AnyNode[]
    const ret = node.returnType?.typeAnnotation as AnyNode | undefined
    return `(${params.map(serializeParam).join(', ')})${ret ? ` => ${serializeTypeName(ret)}` : ''}`
  }
  // 标识符引用（暴露已声明的 const 方法）：回查顶层函数表，查不到就不给 signature
  if (node.type === 'Identifier') return localFns?.get(node.name)?.signature
  return undefined
}

function serializeParam(param: AnyNode): string {
  if (param.type === 'Identifier') {
    const ann = param.typeAnnotation?.typeAnnotation
    const optional = param.optional ? '?' : ''
    return ann ? `${param.name}${optional}: ${serializeTypeName(ann)}` : `${param.name}${optional}`
  }
  if (param.type === 'AssignmentPattern' && param.left?.type === 'Identifier') {
    const ann = param.left.typeAnnotation?.typeAnnotation
    return `${param.left.name}${ann ? `: ${serializeTypeName(ann)}` : ''}?`
  }
  return '?'
}

function serializeTypeName(node: AnyNode): string {
  switch (node.type) {
    case 'TSStringKeyword': return 'string'
    case 'TSNumberKeyword': return 'number'
    case 'TSBooleanKeyword': return 'boolean'
    case 'TSVoidKeyword': return 'void'
    case 'TSNullKeyword': return 'null'
    case 'TSUndefinedKeyword': return 'undefined'
    case 'TSAnyKeyword': return 'any'
    case 'TSUnknownKeyword': return 'unknown'
    case 'TSArrayType': return `${serializeTypeName(node.elementType)}[]`
    case 'TSTupleType': return serializeTupleType(node) ?? '[]'
    case 'TSNamedTupleMember': {
      // 元组命名成员 [kw: string] → 'kw: string'（babel 把 label 与 elementType 分开存）
      const inner = node.elementType?.typeAnnotation ?? node.elementType
      const label = node.label?.name ? `${node.label.name}${node.optional ? '?' : ''}: ` : ''
      return `${label}${inner ? serializeTypeName(inner) : 'unknown'}`
    }
    case 'TSTypeReference': {
      const name = String(node.typeName?.name ?? node.typeName?.right?.name ?? 'unknown')
      const args = (node.typeParameters?.params ?? node.typeArguments?.params) as AnyNode[] | undefined
      return args?.length ? `${name}<${args.map(serializeTypeName).join(', ')}>` : name
    }
    case 'TSLiteralType':
      return JSON.stringify(node.literal?.value) ?? 'unknown'
    case 'TSUnionType': {
      const types = (node.types ?? []) as AnyNode[]
      return types.map(serializeTypeName).join(' | ')
    }
    case 'TSFunctionType': return 'function'
    case 'TSTypeLiteral': return 'object'
    default: return 'unknown'
  }
}

/** 序列号 tuple 形如 `[p: Foo]` → '[p: Foo]'（给 payloadType 用；ctx 在时元素类型展开） */
function serializeTupleType(node: AnyNode, ctx?: ExpandContext): string | undefined {
  const types = (node.elementTypes ?? []) as AnyNode[]
  if (!types.length) return '[]'
  return `[${types.map((element) => serializeTupleElement(element, ctx)).join(', ')}]`
}

function serializeTupleElement(element: AnyNode, ctx?: ExpandContext): string {
  // 命名成员 [kw: string]：label 与 elementType 分开存；失败退回语法级名字
  const inner = element.type === 'TSNamedTupleMember'
    ? (element.elementType?.typeAnnotation ?? element.elementType)
    : element
  const label =
    element.type === 'TSNamedTupleMember' && element.label?.name
      ? `${element.label.name}${element.optional ? '?' : ''}: `
      : ''
  const fallback = inner ? serializeTypeName(inner) : 'unknown'
  return `${label}${ctx?.typeText(inner) ?? fallback}`
}

