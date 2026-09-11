// typeResolver：用 vue-tsc 内核（@vue/language-core + @volar/typescript）做「跨文件类型解析」，
// 把 manifest 里 props / emits 载荷 / exposes 签名中的自定义类型（DatasourceVO、DatasourceRequest ...）
// 展开成真实字段结构（`{ name: string; host: string; ... }`）。
//
// 分工（对应 design D1）：
//   - parseComponent.ts 用 babel 做轻量「找到 defineXxx + 拿 JSDoc 描述」（语法级，位置是原始 .vue 偏移）；
//   - 本模块只做「类型定稿」：把原始 .vue 偏移映射到 vue-tsc 生成的虚拟 TS，再用 checker 拿真实类型并展开。
//
// 一切解析失败（没有 tsconfig / .vue 里找不到对应节点 / 类型在 node_modules）都降级返回名字串，
// 由调用方决定是否回退 babel 行为，不破坏没用 vue-tsc 的宿主项目（design D3）。
import path from 'node:path'
import ts from 'typescript'
import { createParsedCommandLine, createVueLanguagePlugin } from '@vue/language-core'
import { proxyCreateProgram } from '@volar/typescript/lib/node/proxyCreateProgram.js'

/** 展开深度上限（防递归类型爆炸，design D2） */
const DEFAULT_MAX_DEPTH = 4

/** 脚本块虚拟码 id：script_ts / script_tsx / script_js / script_jsx */
const SCRIPT_CODE_PATTERN = /script_(ts|tsx|js|jsx)$/

export interface TypeResolverOptions {
  /** tsconfig.json 的绝对路径（决定 paths 别名 / extends / vueCompilerOptions） */
  tsconfigPath: string
  /** 类型展开深度上限，缺省 4 */
  maxDepth?: number
}

export interface TypeResolver {
  /** vue-tsc 建出来的 program（.vue 已在其中，作为虚拟 TS） */
  program: ts.Program
  /** 拿到节点真实类型的 checker */
  checker: ts.TypeChecker
  /**
   * 取文件的 program 源码：`.vue` 返回 Volar 生成的虚拟 TS，`.ts` 返回原文件。
   * 文件不在 program 里（例如 tsconfig 未 include）返回 undefined。
   */
  getSourceFile(filePath: string): ts.SourceFile | undefined
  /**
   * 把「原始 .vue 源码偏移」映射到 program 虚拟源码偏移。
   * `.ts` 文件是恒等映射；映射不上（不在任何 mapping 区间）返回 undefined。
   */
  toProgramOffset(filePath: string, offset: number): number | undefined
  /** 取原始文件 offset 处节点的真实类型 */
  getTypeAt(filePath: string, offset: number): ts.Type | undefined
  /** 取原始文件 offset 处节点的类型并展开成文本；解析不出返回 undefined */
  serializeTypeAt(filePath: string, offset: number): string | undefined
  /**
   * 取原始文件 offset 处节点的函数签名并展开成文本（如 `(data: { ... }) => Promise<DatasourceVO>`）。
   * 节点不是函数类型时返回 undefined。
   */
  serializeSignatureAt(filePath: string, offset: number): string | undefined
}

/* -------------------------------------------------------------------------- */
/* Volar 内部结构的最小结构类型（不直接依赖 @volar/language-core 的类型）        */
/* -------------------------------------------------------------------------- */

interface CodeMappingLike {
  sourceOffsets: number[]
  generatedOffsets: number[]
  lengths: number[]
}

interface VirtualCodeLike {
  id: string
  snapshot: { getLength(): number; getText(start: number, end: number): string }
  mappings?: CodeMappingLike[]
  embeddedCodes?: VirtualCodeLike[]
}

interface LanguagePluginLike {
  createVirtualCode?: (fileId: string, languageId: string, snapshot: unknown) => VirtualCodeLike | undefined
  updateVirtualCode?: (fileId: string, code: VirtualCodeLike, snapshot: unknown) => VirtualCodeLike
  [key: string]: unknown
}

/** tsc 靠 patch 源码把 `.vue` 加进 supportedExtensions；这里通过导出的 getSupportedExtensions 原地注入 */
type TypeScriptWithInternals = typeof ts & {
  getSupportedExtensions(options?: ts.CompilerOptions): string[][]
}

let vueExtensionRegistered = false

function registerVueExtension(): void {
  if (vueExtensionRegistered) return
  const internals = ts as TypeScriptWithInternals
  // 不开 allowJs 时用 supportedTSExtensions，开了用 allSupportedExtensions —— 两个数组都要补 .vue
  for (const probe of [{}, { allowJs: true }] as ts.CompilerOptions[]) {
    for (const group of internals.getSupportedExtensions(probe)) {
      if (!group.includes('.vue')) group.push('.vue')
    }
  }
  vueExtensionRegistered = true
}


/* -------------------------------------------------------------------------- */
/* 建 program                                                                 */
/* -------------------------------------------------------------------------- */

export function createTypeResolver(options: TypeResolverOptions): TypeResolver {
  const tsconfigPath = path.resolve(options.tsconfigPath)
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  registerVueExtension()

  // skipGlobalTypesSetup=true：不往宿主 node_modules 写 .vue-global-types，纯读不写（解析类型不需要它）
  const parsed = createParsedCommandLine(ts, ts.sys, tsconfigPath, true)
  const vueOptions = parsed.vueOptions
  const virtualCodes = new Map<string, VirtualCodeLike>()

  const createProgram = proxyCreateProgram(ts, ts.createProgram, (tsObj, createOptions) => {
    const vuePlugin = createVueLanguagePlugin(tsObj, createOptions.options, vueOptions, (id: string) => id)
    const captured = captureVirtualCodes(vuePlugin as unknown as LanguagePluginLike, virtualCodes)
    return { languagePlugins: [captured as unknown as typeof vuePlugin] }
  })

  const program = createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    host: ts.createCompilerHost(parsed.options),
  })
  const checker = program.getTypeChecker()

  const sourceFileOf = (filePath: string): ts.SourceFile | undefined =>
    program.getSourceFile(path.resolve(filePath))

  /** 原始偏移 → program 虚拟源码偏移 */
  const toProgramOffset = (filePath: string, offset: number): number | undefined => {
    const sourceFile = sourceFileOf(filePath)
    if (!sourceFile) return undefined
    const root = virtualCodes.get(sourceFile.fileName) ?? virtualCodes.get(path.resolve(filePath))
    // 普通 .ts/.tsx：program 源码就是原文件，恒等映射
    if (!root) return offset
    const script = findScriptCode(root)
    if (!script) return undefined
    const embeddedText = script.snapshot.getText(0, script.snapshot.getLength())
    if (!sourceFile.text.endsWith(embeddedText)) return undefined
    // Volar 把整个 .vue 原文「字符变空格」后拼上脚本虚拟码，所以虚拟脚本起点 = 原文长度
    const padding = sourceFile.text.length - embeddedText.length
    const generated = translateOffset(script.mappings, offset)
    return generated === undefined ? undefined : padding + generated
  }

  const locate = (filePath: string, offset: number): { node: ts.Node; type: ts.Type } | undefined => {
    const programOffset = toProgramOffset(filePath, offset)
    if (programOffset === undefined) return undefined
    const sourceFile = sourceFileOf(filePath)
    if (!sourceFile) return undefined
    const node = climbToTypeNode(findNodeAt(sourceFile, programOffset), sourceFile)
    const type = checker.getTypeAtLocation(node)
    return type ? { node, type } : undefined
  }

  return {
    program,
    checker,
    getSourceFile: sourceFileOf,
    toProgramOffset,
    getTypeAt(filePath, offset) {
      return locate(filePath, offset)?.type
    },
    serializeTypeAt(filePath, offset) {
      const found = locate(filePath, offset)
      return found ? serializeType(checker, found.type, found.node, 0, undefined, maxDepth) : undefined
    },
    serializeSignatureAt(filePath, offset) {
      const found = locate(filePath, offset)
      if (!found) return undefined
      const signature = found.type.getCallSignatures()[0]
      if (!signature) return undefined
      return serializeSignature(checker, signature, found.node, 0, new Set(), maxDepth)
    },
  }
}

/** 包一层 plugin，把 Volar 生成的根虚拟码（含 mappings）截留下来 —— 这是「原文偏移 ↔ 虚拟码偏移」映射的唯一来源 */
function captureVirtualCodes(plugin: LanguagePluginLike, store: Map<string, VirtualCodeLike>): LanguagePluginLike {
  const originalCreate = plugin.createVirtualCode
  const originalUpdate = plugin.updateVirtualCode
  return {
    ...plugin,
    createVirtualCode(fileId, languageId, snapshot) {
      const code = originalCreate?.call(plugin, fileId, languageId, snapshot)
      if (code) store.set(fileId, code)
      return code
    },
    updateVirtualCode(fileId, code, snapshot) {
      const next = originalUpdate ? originalUpdate.call(plugin, fileId, code, snapshot) : code
      store.set(fileId, next)
      return next
    },
  }
}

function findScriptCode(root: VirtualCodeLike): VirtualCodeLike | undefined {
  if (SCRIPT_CODE_PATTERN.test(root.id)) return root
  for (const child of root.embeddedCodes ?? []) {
    const found = findScriptCode(child)
    if (found) return found
  }
  return undefined
}

/** source（.vue 原文）偏移 → 脚本虚拟码偏移；落在 mapping 区间外返回 undefined */
function translateOffset(mappings: CodeMappingLike[] | undefined, offset: number): number | undefined {
  for (const mapping of mappings ?? []) {
    const { sourceOffsets, generatedOffsets, lengths } = mapping
    for (let i = 0; i < sourceOffsets.length; i += 1) {
      const start = sourceOffsets[i]
      if (offset >= start && offset < start + lengths[i]) {
        return generatedOffsets[i] + (offset - start)
      }
    }
  }
  return undefined
}

/** 取包含 position 的最深节点（offset 落在 [start, end) 内） */
function findNodeAt(sourceFile: ts.SourceFile, position: number): ts.Node {
  let best: ts.Node = sourceFile
  const visit = (node: ts.Node): void => {
    let start: number
    try {
      start = node.getStart(sourceFile)
    } catch {
      return
    }
    if (position < start || position >= node.getEnd()) return
    best = node
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return best
}

/**
 * 把 findNodeAt 拿到的「最深节点」向上收敛到「起点相同的最外层类型节点」。
 *
 * 为什么需要：调用方（parseComponent）给的偏移是**类型注解节点的起点**，而该起点常常同时是
 * 内部标识符的起点 —— `Foo[]` 的 `Foo`、`Partial<X>` 的 `Partial`。findNodeAt 取最深节点，
 * 于是拿到的是 Identifier，`getTypeAtLocation` 返回的便是「符号声明类型」：
 * `Partial<X>` 退化成泛型声明形态 `Partial<T>`、`Foo[]` 丢掉 `[]` 只剩元素类型。
 *
 * 收紧条件：只在**父节点是类型节点（ts.isTypeNode）且起点与当前节点一致**时才上爬，
 * 所以值位置的标识符（`defineExpose({ refresh })` 里的 `refresh`、形参名 `patch`）原样不动。
 */
function climbToTypeNode(node: ts.Node, sourceFile: ts.SourceFile): ts.Node {
  let current = node
  let start: number
  try {
    start = current.getStart(sourceFile)
  } catch {
    return current
  }
  for (;;) {
    const parent = current.parent
    if (!parent || !ts.isTypeNode(parent)) break
    let parentStart: number
    try {
      parentStart = parent.getStart(sourceFile)
    } catch {
      break
    }
    if (parentStart !== start) break
    current = parent
  }
  return current
}

/* -------------------------------------------------------------------------- */
/* 类型序列化                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 把 checker 拿到的真实类型展开成文本：
 * 基本类型 / 数组 / 元组 / 联合 / 枚举 / interface / type 别名 → `{ field: type }`；
 * 项目内类型递归展开，node_modules 里的类型（AxiosResponse、Record ...）只打印名字；
 * 深度上限 + 环检测防递归爆炸（design D2）。
 */
export function serializeType(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
  depth = 0,
  seen: Set<ts.Type> = new Set(),
  maxDepth = DEFAULT_MAX_DEPTH,
): string {
  return serializeTypeNode(checker, type, node, depth, seen, maxDepth)
}

/** 把函数签名展开成 `(data: {...}) => Promise<...>` */
export function serializeSignature(
  checker: ts.TypeChecker,
  signature: ts.Signature,
  node: ts.Node,
  depth = 0,
  seen: Set<ts.Type> = new Set(),
  maxDepth = DEFAULT_MAX_DEPTH,
): string {
  const params = signature.getParameters().map((param) => {
    const declaration = param.valueDeclaration
    const parameter = declaration && ts.isParameter(declaration) ? declaration : undefined
    // 函数「类型」的形参符号不带 Optional：`x?: T` / `x = 1` 要看声明上的 questionToken / initializer
    const optional =
      !!(param.flags & ts.SymbolFlags.Optional) || !!(parameter && (parameter.questionToken || parameter.initializer))
    const rest = parameter?.dotDotDotToken ? '...' : ''
    const paramType = checker.getTypeOfSymbolAtLocation(param, node)
    const text = serializeOptional(checker, paramType, node, optional, depth + 1, seen, maxDepth)
    return `${rest}${param.getName()}${optional ? '?' : ''}: ${text}`
  })
  const returnType = signature.getReturnType()
  return `(${params.join(', ')}) => ${serializeTypeNode(checker, returnType, node, depth + 1, seen, maxDepth)}`
}

/**
 * 序列化「可选」属性/参数的类型：TS 会把 `?` 表达成 `T | undefined`，
 * 这里剥掉隐式 undefined，避免 manifest 里出现 `port?: undefined | number` 这种噪音。
 */
function serializeOptional(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
  optional: boolean,
  depth: number,
  seen: Set<ts.Type>,
  maxDepth: number,
): string {
  if (optional && type.isUnion()) {
    const members = type.types.filter((item) => !(item.flags & ts.TypeFlags.Undefined))
    if (members.length && members.length < type.types.length) {
      if (members.length === 1) return serializeTypeNode(checker, members[0], node, depth, seen, maxDepth)
      if (members.length === 2 && members.every((item) => item.flags & ts.TypeFlags.BooleanLiteral)) return 'boolean'
      return members.map((item) => serializeTypeNode(checker, item, node, depth, seen, maxDepth)).join(' | ')
    }
  }
  return serializeTypeNode(checker, type, node, depth, seen, maxDepth)
}

function serializeTypeNode(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
  depth: number,
  seen: Set<ts.Type>,
  maxDepth: number,
): string {
  const recurse = (item: ts.Type, nextDepth: number): string =>
    serializeTypeNode(checker, item, node, nextDepth, seen, maxDepth)

  // 到达深度上限：不再展开，只打印名字（外部类型也多走这条）
  if (depth > maxDepth) return typeName(checker, type)
  // 环检测：同一个类型对象再次出现 → 只打印名字
  if (seen.has(type)) return typeName(checker, type)

  // 联合：布尔退化成 boolean；其余逐支展开（枚举成员也落在这一支）
  if (type.isUnion()) {
    if (type.flags & ts.TypeFlags.Boolean) return 'boolean'
    return type.types.map((item) => recurse(item, depth)).join(' | ')
  }
  if (type.isIntersection()) {
    return type.types.map((item) => recurse(item, depth)).join(' & ')
  }

  // 字面量
  if (type.flags & ts.TypeFlags.BooleanLiteral) return intrinsicName(type, 'boolean')
  if (type.isStringLiteral()) return JSON.stringify(type.value)
  if (type.isNumberLiteral()) return String(type.value)
  if (type.flags & ts.TypeFlags.BigIntLiteral) return `${String((type as ts.BigIntLiteralType).value.base10Value)}n`

  // 基本类型
  if (type.flags & ts.TypeFlags.Any) return 'any'
  if (type.flags & ts.TypeFlags.Unknown) return 'unknown'
  if (type.flags & ts.TypeFlags.Never) return 'never'
  if (type.flags & ts.TypeFlags.Void) return 'void'
  if (type.flags & ts.TypeFlags.Undefined) return 'undefined'
  if (type.flags & ts.TypeFlags.Null) return 'null'
  if (type.flags & ts.TypeFlags.String) return 'string'
  if (type.flags & ts.TypeFlags.Number) return 'number'
  if (type.flags & ts.TypeFlags.BigInt) return 'bigint'
  if (type.flags & ts.TypeFlags.ESSymbolLike) return 'symbol'
  if (type.flags & ts.TypeFlags.NonPrimitive) return 'object'

  // 数组 / 元组
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type as ts.TypeReference)
    return element ? `${recurse(element, depth + 1)}[]` : 'unknown[]'
  }
  if (checker.isTupleType(type)) {
    const elements = checker.getTypeArguments(type as ts.TypeReference)
    return `[${elements.map((item) => recurse(item, depth + 1)).join(', ')}]`
  }

  // 非 union 的枚举类型（少见）：只打印枚举名
  if (type.flags & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral)) return typeName(checker, type)

  // 函数类型：展开成签名
  const callSignatures = type.getCallSignatures()
  if (callSignatures.length && !checker.getPropertiesOfType(type).length) {
    return serializeSignature(checker, callSignatures[0], node, depth, seen, maxDepth)
  }

  // 项目内类型：递归展开字段（node_modules 类型不展开，只打印名字）
  if (isProjectType(type)) {
    const expanded = expandObjectProperties(checker, type, node, depth, seen, maxDepth)
    if (expanded) return expanded
  }

  // Partial<T> / Required<T> / Readonly<T> / Pick<T, K> / Omit<T, K> 这类 mapped 类型声明在 TS lib
  // （node_modules）里，但类型参数可能是项目内类型 —— 此时按对象展开（`Partial<DatasourceFilter>`
  // → `{ keyword?: string; ... }`），比打印 `Partial<{...}>` 更贴近「照着实参传」的用途。
  // 类型参数全在项目外时保持原样只打印名字（`Record<string, string>`，design D2）。
  if (isMappedWithProjectArgument(type)) {
    const expanded = expandObjectProperties(checker, type, node, depth, seen, maxDepth)
    if (expanded) return expanded
  }

  // 其余外部泛型实例化（Promise<T> / Set<T> / AxiosResponse<T> ...）：名字保留，但类型参数继续展开，
  // 不能把整棵子树压成一个名字（否则 `Promise<Foo>` / `Partial<Foo>` 里的 Foo 永远看不到字段）。
  const typeArguments = typeArgumentsOf(checker, type)
  if (typeArguments.length) {
    const args = typeArguments.map((item) => recurse(item, depth + 1)).join(', ')
    return `${bareTypeName(checker, type)}<${args}>`
  }

  return typeName(checker, type)
}

/** 对象类型 → `{ field: type; ... }`；属性为空返回 undefined，由调用方决定回退成名字 */
function expandObjectProperties(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
  depth: number,
  seen: Set<ts.Type>,
  maxDepth: number,
): string | undefined {
  const properties = checker.getPropertiesOfType(type)
  if (!properties.length) return undefined
  seen.add(type)
  try {
    const body = properties.map((prop) => {
      const optional = !!(prop.flags & ts.SymbolFlags.Optional)
      const propType = checker.getTypeOfSymbolAtLocation(prop, node)
      const text = serializeOptional(checker, propType, node, optional, depth + 1, seen, maxDepth)
      return `${propertyName(prop.getName())}${optional ? '?' : ''}: ${text}`
    })
    return `{ ${body.join('; ')} }`
  } finally {
    seen.delete(type)
  }
}

/** mapped 类型（Partial/Readonly/Pick/Omit ...）且类型参数里有项目内类型 —— 值得按对象展开 */
function isMappedWithProjectArgument(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false
  if (!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped)) return false
  const args = type.aliasTypeArguments
  return !!args?.length && args.some((item) => isProjectType(item))
}

/** 泛型实例化的类型参数（仅 Reference 类型有；数组 / 元组已在前面的分支处理掉） */
function typeArgumentsOf(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if (!(type.flags & ts.TypeFlags.Object)) return []
  if (!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return []
  return checker.getTypeArguments(type as ts.TypeReference)
}

/** 只取名字，不带类型参数（`Promise<X>` → `Promise`） */
function bareTypeName(checker: ts.TypeChecker, type: ts.Type): string {
  const name = (type.aliasSymbol ?? type.getSymbol())?.getName()
  if (name && name !== '__type' && name !== '__object') return name
  // 匿名 / 别名兜底：把 `Foo<...>` 的尖括号尾巴削掉
  return typeName(checker, type).replace(/<[\s\S]*>$/, '')
}

function isProjectType(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol()
  const declaration = symbol?.declarations?.[0]
  if (!declaration) return false
  return !isExternalFile(declaration.getSourceFile().fileName)
}

/** node_modules 里的类型（含 typescript lib）只打印名字 */
function isExternalFile(fileName: string): boolean {
  return fileName.includes('/node_modules/') || fileName.includes('\\node_modules\\')
}

function typeName(checker: ts.TypeChecker, type: ts.Type): string {
  return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
}

function intrinsicName(type: ts.Type, fallback: string): string {
  return (type as { intrinsicName?: string }).intrinsicName ?? fallback
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}
