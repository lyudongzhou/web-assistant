// analyzer：读 wc.pages.json（与构建插件同一份真相来源）+ 页面源码 → 生成 manifest v2。
//
//   analyzer --config <wc.pages.json> [--out <manifest.json>] [--tsconfig <tsconfig.json>] [--no-ai]
//
// 静态解析分两层（design D1）：babel 找 defineXxx + JSDoc，vue-tsc 内核（typeResolver）把类型定稿；
// 定稿后的结构骨架（PageFacts）才喂给 AI，AI 只补语义（design D4）。
//
// 产出的 bundle / 容器路径由 @webassistant/protocol 的命名规则算出，
// 与 vite-plugin-wc 的产物结构严格一致（两边共用同一套函数，不会漂移）。
import fs from 'node:fs'
import path from 'node:path'
import {
  MANIFEST_VERSION,
  containerBundlePath,
  containerTagName,
  pageBundlePath,
  resolveTag,
  DEFAULT_FRAMEWORK,
  type ManifestPage,
  type RuntimeManifest,
  type WcPagesConfig,
} from '@webassistant/protocol'
import { extractParams, parseComponent, type ParsedComponent } from './parseComponent.js'
import { resolveRuleEntries } from './rules.js'
import { createTypeResolver, type TypeResolver } from './typeResolver.js'
import {
  analyzeWithAI,
  applyAiDescriptions,
  type AiOptions,
  type AiPageResult,
  type PageFacts,
} from './ai.js'

// 规则收集（wc.pages.json 的 rules 声明 → manifest.rules）供 analyzer / vite-plugin-wc 共用
export {
  resolveRuleEntries,
  collectRuleWatchPaths,
  collectConfigRuleWatchPaths,
  parseRuleMarkdown,
} from './rules.js'

export interface AnalyzeOptions {
  /** wc.pages.json 的绝对路径 */
  configPath: string
  /** manifest 输出路径，缺省为 wc.pages.json 同目录的 manifest.json */
  outPath?: string
  /** 关掉 AI 语义分析（只做静态解析） */
  noAi?: boolean
  /**
   * tsconfig.json 绝对路径（vue-tsc 内核用它解析 paths/extends/全局类型）。
   * 缺省取 wc.pages.json 同目录的 tsconfig.json；找不到就降级为语法级解析。
   */
  tsconfigPath?: string
  /** AI 配置；缺省读取宿主进程环境 */
  ai?: Omit<AiOptions, 'cacheFile'>
  /** AI 结果缓存文件路径；缺省为 wc.pages.json 同目录 .analyze-cache.json */
  aiCacheFile?: string
}

/**
 * 定位 tsconfig 并建 vue-tsc 内核的类型解析器（design D3）：
 * 缺省取项目根（wc.pages.json 同目录）的 tsconfig.json，`tsconfigPath` 可覆盖。
 * 找不到 / 初始化失败（例如没装 vue 语言插件）时返回 undefined —— 调用方降级回语法级解析，
 * 不破坏没用 vue-tsc 的宿主项目。
 */
export function resolveComponentTypes(projectRoot: string, tsconfigPath?: string): TypeResolver | undefined {
  const candidate = tsconfigPath ? path.resolve(tsconfigPath) : path.join(projectRoot, 'tsconfig.json')
  if (!fs.existsSync(candidate)) return undefined
  try {
    return createTypeResolver({ tsconfigPath: candidate })
  } catch (cause) {
    console.warn(`  ⚠️ vue-tsc 内核初始化失败，降级为语法级解析：${(cause as Error).message}`)
    return undefined
  }
}

function fallbackDescription(title: string | undefined, name: string, comp: ParsedComponent): string {
  const parts = [title ? `${title}页面` : `${name}页面`]
  if (comp.events.length) parts.push(`支持${comp.events.map((e) => e.name).join('、')}等操作`)
  if (comp.props.length) parts.push(`可接收${comp.props.map((p) => p.name).join('、')}等数据`)
  return parts.join('，')
}

export async function analyze(options: AnalyzeOptions): Promise<RuntimeManifest> {
  const configPath = options.configPath
  const root = path.dirname(configPath)
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as WcPagesConfig
  const framework = config.framework || DEFAULT_FRAMEWORK

  // vue-tsc 内核只建一次，整批页面共用（.vue 已在 program 里，跨文件类型可解析）
  const resolver = resolveComponentTypes(root, options.tsconfigPath)

  const pages: ManifestPage[] = []
  // 宿主直连批次（用法 B）：wc.pages.json 没声明 container → 不写 containers / pages[].bundle
  const hostOnly = !config.container
  for (const page of config.pages) {
    const tag = resolveTag(page)
    // 同一份清单会**同时驱动 WC 构建**（vite-plugin-wc 的 loadWcPages 要求 tag 是合法自定义元素名）。
    // 这里提前警告：否则要到 `pnpm build:ce` 才由插件报错 —— 报错点在构建期，离清单很远，不易定位。
    if (!hostOnly && !tag.includes('-')) {
      console.warn(
        `  ⚠️ 页面 ${page.name} 的 tag「${tag}」不含 '-'：本清单声明了 container（走 WC 构建），` +
          "自定义元素标签必须包含 '-'。请改 tag（一份清单驱动两批时，所有 tag 都要满足）。",
      )
    }
    const routePath = page.path || `/${tag}`
    const componentPath = path.resolve(root, page.component)
    const exists = fs.existsSync(componentPath)
    if (!exists) console.warn(`  ⚠️ 找不到组件：${componentPath}`)

    const comp: ParsedComponent = exists
      ? parseComponent(componentPath, { resolver })
      : { description: '', props: [], events: [], exposes: [] }

    // 本地先定稿：PageFacts 的字段名/类型/签名已经展开好，AI 只在这份骨架上补语义
    const params = extractParams(routePath)
    const facts: PageFacts = {
      description: comp.description,
      props: comp.props,
      params,
      events: comp.events.map((e) => e.name),
      emits: comp.events,
      exposes: comp.exposes,
    }

    let ai: AiPageResult | null = null
    if (exists && !options.noAi) {
      try {
        const aiCacheFile = options.aiCacheFile
          ? path.resolve(options.aiCacheFile)
          : path.join(root, '.analyze-cache.json')
        ai = await analyzeWithAI(
          { name: page.name, path: routePath, title: page.title, facts },
          { ...options.ai, cacheFile: aiCacheFile },
        )
      } catch (cause) {
        console.warn(`  ⚠️ <${tag}> AI 分析失败，回退静态：${(cause as Error).message}`)
      }
    }

    // AI 只能「填空」：给缺 description 的 props / emits / exposes 补说明，不改结构
    const props = applyAiDescriptions(comp.props, ai?.propDescriptions)
    const emits = applyAiDescriptions(comp.events, ai?.emitDescriptions)
    const exposes = applyAiDescriptions(comp.exposes, ai?.methodDescriptions)
    // 页面级规则（仅该页面生效）：自动收集页面条目的 rules 声明
    const pageRules = resolveRuleEntries(root, page.rules)

    pages.push({
      tag,
      name: page.name,
      path: routePath,
      title: page.title,
      framework,
      // 宿主直连批次没有页面产物（页面就是宿主的路由组件）
      ...(hostOnly ? {} : { bundle: pageBundlePath(tag) }),
      params,
      props,
      // events：runtime 的 CE 事件监听白名单，必须是「名字数组」
      // （wc-runtime-core/manifest.ts → runtime.view.events → vue/container.ts buildListeners）
      events: comp.events.map((e) => e.name),
      // emits：同一批事件的富信息（payloadType / description），只给 agent 规划与 prompt 用
      emits: emits.length ? emits : undefined,
      // exposes：agent 可用 call_page_method 调用的方法清单
      exposes: exposes.length ? exposes : undefined,
      description: ai?.description || comp.description || fallbackDescription(page.title, page.name, comp),
      keywords: ai?.keywords ?? [],
      exampleQueries: ai?.exampleQueries ?? [],
      // 页面级规则：未声明则不写字段（避免噪音）
      ...(pageRules.length ? { rules: pageRules } : {}),
      // 数据源声明：原样透传（单一来源 = wc.pages.json，避免手改产物被下次 analyze 冲掉）
      ...(page.dataSources?.length ? { dataSources: page.dataSources } : {}),
    })
  }

  const manifest: RuntimeManifest = {
    version: MANIFEST_VERSION,
    containers: hostOnly
      ? {}
      : {
          [framework]: {
            bundle: containerBundlePath(framework),
            tagName: containerTagName(framework),
          },
        },
    pages,
  }
  if (config.sharedStyles?.length) manifest.styles = { shared: config.sharedStyles }
  // 项目规则（一波页面一波规则）：自动收集 wc.pages.json 的 rules 声明并内联下发
  const rules = resolveRuleEntries(root, config.rules)
  if (rules.length) manifest.rules = rules
  return manifest
}
