// wcManifestPlugin：把 analyzer 的分析能力集成到 Vite 构建/开发流程
// - build: closeBundle 时生成/更新 manifest.json
// - dev: watch wc.pages.json + 页面源码变化 → 增量重生成 manifest（热更新）
// - 增量策略：指纹对比（source + path + title + component + framework）
// - 手工字段保留：旧 manifest 有 dataSources 等且新无 → 保留旧值

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  MANIFEST_VERSION,
  MANIFEST_FILE,
  WC_PAGES_FILE,
  resolveTag,
  pageBundlePath,
  containerBundlePath,
  containerTagName,
  type RuntimeManifest,
  type WcPagesConfig,
  type WcPageEntry,
} from '@webassistant/protocol'
import { loadWcPages } from './config.js'
import {
  collectConfigRuleWatchPaths,
  resolveComponentTypes,
  resolvePageParams,
  resolveRuleEntries,
} from '@webassistant/analyzer'
import { parseComponent, type ParsedComponent } from '@webassistant/analyzer/parseComponent'
import {
  applyAiDescriptions,
  type AiOptions,
  type AiPageResult,
  type PageFacts,
} from '@webassistant/analyzer/ai'
import { loadEnv } from 'vite'

/** vue-tsc 内核类型解析器（可能为 undefined = 降级为语法级解析） */
type ComponentTypes = ReturnType<typeof resolveComponentTypes>

export interface WcManifestOptions {
  /** wc.pages.json 路径（相对 root），缺省 'wc.pages.json' */
  configPath?: string
  /** manifest 输出路径，缺省 wc.pages.json 同目录 manifest.json */
  outPath?: string
  /** 关闭 AI 语义分析（仅静态） */
  noAi?: boolean
  /** 增量缓存文件路径，缺省项目根 '.wc-manifest-cache.json' */
  cacheFile?: string
  /** AI 结果缓存文件路径，缺省项目根 '.analyze-cache.json' */
  aiCacheFile?: string
  /** tsconfig.json 路径（相对 root）供 vue-tsc 内核解析类型；缺省项目根 tsconfig.json */
  tsconfigPath?: string
  /** dev 模式是否启用 watch 增量更新，缺省 true */
  watch?: boolean
  /** 显式 AI 配置；未传时由调用方环境提供 */
  ai?: Omit<AiOptions, 'cacheFile'>
}

interface PageFingerprint {
  tag: string
  fingerprint: string
  analyzedAt: number
}

interface ManifestCache {
  version: number
  pages: PageFingerprint[]
}

// 计算页面指纹：sourceCode + routePath + title + componentPath + framework
function computeFingerprint(
  source: string,
  routePath: string,
  title: string | undefined,
  componentPath: string,
  framework: string,
): string {
  const hash = crypto.createHash('sha256')
  hash.update(source)
  hash.update('\n')
  hash.update(routePath)
  hash.update('\n')
  hash.update(title ?? '')
  hash.update('\n')
  hash.update(componentPath)
  hash.update('\n')
  hash.update(framework)
  return hash.digest('hex').slice(0, 32)
}

// 读取缓存文件
function readCache(cacheFile: string): ManifestCache {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
    if (raw?.version === 1 && Array.isArray(raw.pages)) return raw
  } catch {
    // ignore
  }
  return { version: 1, pages: [] }
}

// 写入缓存文件
function writeCache(cacheFile: string, cache: ManifestCache): void {
  fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`)
}

// 读取旧 manifest
function readOldManifest(outPath: string): RuntimeManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(outPath, 'utf-8'))
    if (raw?.version === MANIFEST_VERSION && Array.isArray(raw.pages)) return raw
  } catch {
    // ignore
  }
  return null
}

// 合并：旧 manifest 的 dataSources 等手工字段迁移到新页面
function mergeHandcraftedFields(
  newPage: RuntimeManifest['pages'][0],
  oldPage: RuntimeManifest['pages'][0] | undefined,
): RuntimeManifest['pages'][0] {
  if (!oldPage) return newPage
  const merged = { ...newPage }
  // dataSources：旧有且新无 → 保留旧
  if (oldPage.dataSources?.length && !merged.dataSources?.length) {
    merged.dataSources = oldPage.dataSources
  }
  // rules（页面级）：旧有且新无 → 保留旧（手工字段保留策略）
  if (oldPage.rules?.length && !merged.rules?.length) {
    merged.rules = oldPage.rules
  }
  // meta：合并旧 meta（新字段优先）
  if (oldPage.meta) {
    merged.meta = { ...oldPage.meta, ...merged.meta }
  }
  return merged
}

function fallbackDescription(title: string | undefined, name: string, comp: ParsedComponent): string {
  const parts = [title ? `${title}页面` : `${name}页面`]
  if (comp.events.length) parts.push(`支持${comp.events.map((e) => e.name).join('、')}等操作`)
  if (comp.props.length) parts.push(`可接收${comp.props.map((p) => p.name).join('、')}等数据`)
  return parts.join('，')
}

// 分析单页：返回 ManifestPage（静态结构由 vue-tsc 内核定稿，AI 只补语义；noAi 时仅静态）
async function analyzePage(
  page: WcPageEntry,
  config: WcPagesConfig & { framework: string },
  root: string,
  noAi: boolean,
  aiOptions: Omit<AiOptions, 'cacheFile'>,
  aiCacheFile: string,
  resolver: ComponentTypes,
): Promise<RuntimeManifest['pages'][0]> {
  const tag = resolveTag(page)
  const routePath = page.path || `/${tag}`
  const componentPath = path.resolve(root, page.component)
  const exists = fs.existsSync(componentPath)
  const comp: ParsedComponent = exists
    ? parseComponent(componentPath, { resolver })
    : { description: '', props: [], events: [], exposes: [] }

  // 页面入参：path 段（正则）+ 源码里读到的 route.query.x（探测）+ 清单显式 query 声明
  // 与 analyzer/analyze.ts 共用 resolvePageParams —— 两条构建路径不再各算一套（含通道标记 in）
  const resolvedParams = resolvePageParams(routePath, exists ? componentPath : null, {
    props: comp.props,
    explicit: page.query,
  })
  for (const warning of resolvedParams.warnings) console.warn(`  ⚠️ ${page.name}：${warning}`)

  // 本地先定稿：PageFacts 里的字段名/类型/签名已展开，AI 只在这份骨架上补语义
  const facts: PageFacts = {
    description: comp.description,
    props: comp.props,
    params: resolvedParams.params,
    events: comp.events.map((e) => e.name),
    emits: comp.events,
    exposes: comp.exposes,
  }

  // AI 语义分析（仅在需要时懒加载）
  let ai: AiPageResult | null = null
  if (exists && !noAi) {
    try {
      const { analyzeWithAI } = await import('@webassistant/analyzer/ai')
      ai = await analyzeWithAI(
        { name: page.name, path: routePath, title: page.title, facts },
        { ...aiOptions, cacheFile: aiCacheFile },
      )
    } catch (err) {
      console.warn(`  ⚠️ <${tag}> AI 分析失败，回退静态：${(err as Error).message}`)
    }
  }

  // AI 只能「填空」：给缺 description 的 props / params / emits / exposes 补说明，不改结构
  const params = applyAiDescriptions(resolvedParams.params, ai?.paramDescriptions)
  const props = applyAiDescriptions(comp.props, ai?.propDescriptions)
  const emits = applyAiDescriptions(comp.events, ai?.emitDescriptions)
  const exposes = applyAiDescriptions(comp.exposes, ai?.methodDescriptions)
  // 页面级规则（仅该页面生效）
  const pageRules = resolveRuleEntries(root, page.rules)

  return {
    tag,
    name: page.name,
    path: routePath,
    title: page.title,
    framework: config.framework,
    // 宿主直连批次（无 container）没有页面产物
    ...(config.container ? { bundle: pageBundlePath(tag) } : {}),
    params,
    props,
    // 与 analyzer/analyze.ts 保持一致的双写：events = runtime 监听白名单（名字数组），
    // emits = 事件富信息，exposes = agent 可调用方法清单。
    events: comp.events.map((e) => e.name),
    emits: emits.length ? emits : undefined,
    exposes: exposes.length ? exposes : undefined,
    description: ai?.description || comp.description || fallbackDescription(page.title, page.name, comp),
    keywords: ai?.keywords ?? [],
    exampleQueries: ai?.exampleQueries ?? [],
    // 页面级规则：未声明则不写字段（避免噪音）
    ...(pageRules.length ? { rules: pageRules } : {}),
  }
}

// 主入口：增量生成 manifest
// 返回生成后的 manifest，并在 outPath 落盘；同时更新指纹缓存 cacheFile
export async function generateManifestIncremental(
  root: string,
  options: WcManifestOptions = {},
): Promise<RuntimeManifest> {
  const configPath = options.configPath ?? WC_PAGES_FILE
  const config = loadWcPages(root, configPath)
  const outPath = options.outPath
    ? path.resolve(root, options.outPath)
    : path.join(path.dirname(path.resolve(root, configPath)), MANIFEST_FILE)
  const cacheFile = options.cacheFile
    ? path.resolve(root, options.cacheFile)
    : path.resolve(root, '.wc-manifest-cache.json')

  // AI 结果缓存路径由插件显式传给 analyzer，避免污染宿主进程环境
  const aiCacheFile = options.aiCacheFile
    ? path.resolve(root, options.aiCacheFile)
    : path.resolve(root, '.analyze-cache.json')

  // 读取缓存与旧 manifest
  const cache = readCache(cacheFile)
  const oldManifest = readOldManifest(outPath)
  const oldPagesMap = new Map(oldManifest?.pages.map((p) => [p.tag, p]) ?? [])

  // vue-tsc 内核只建一次，整批页面共用；找不到 tsconfig 就降级为语法级解析
  const resolver = resolveComponentTypes(
    root,
    options.tsconfigPath ? path.resolve(root, options.tsconfigPath) : undefined,
  )

  const newPages: RuntimeManifest['pages'] = []
  const newCachePages: PageFingerprint[] = []

  for (const page of config.pages) {
    const tag = resolveTag(page)
    const routePath = page.path || `/${tag}`
    const componentPath = path.resolve(root, page.component)
    const exists = fs.existsSync(componentPath)
    const source = exists ? fs.readFileSync(componentPath, 'utf-8') : ''

    const fingerprint = computeFingerprint(source, routePath, page.title, componentPath, config.framework)
    const cached = cache.pages.find((c) => c.tag === tag)

    let analyzedPage: RuntimeManifest['pages'][0]

    if (cached?.fingerprint === fingerprint && oldPagesMap.has(tag)) {
      // 🎯 未变化：直接复用旧条目（保留 dataSources 等手工字段）
      analyzedPage = oldPagesMap.get(tag)!
      newCachePages.push(cached)
    } else {
      // 🔄 变化/新增：重新分析
      analyzedPage = await analyzePage(
        page,
        config,
        root,
        options.noAi ?? false,
        options.ai ?? {},
        aiCacheFile,
        resolver,
      )
      // 合并手工字段
      analyzedPage = mergeHandcraftedFields(analyzedPage, oldPagesMap.get(tag))
      newCachePages.push({ tag, fingerprint, analyzedAt: Date.now() })
    }

    newPages.push(analyzedPage)
  }

  // 组装 manifest
  // 宿主直连批次（wc.pages.json 未声明 container）：只出页面目录，不写 containers
  const hostOnly = !config.container
  const manifest: RuntimeManifest = {
    version: MANIFEST_VERSION,
    containers: hostOnly
      ? {}
      : {
          [config.framework]: {
            bundle: containerBundlePath(config.framework),
            tagName: containerTagName(config.framework),
          },
        },
    pages: newPages,
  }
  if (config.sharedStyles?.length) manifest.styles = { shared: config.sharedStyles }

  // 项目规则（一波页面一波规则）：声明的规则自动收集内联；
  // 未声明但旧 manifest 有 → 保留旧值（与 dataSources 同款「手工字段保留」策略）。
  const rules = resolveRuleEntries(root, config.rules)
  if (rules.length) manifest.rules = rules
  else if (oldManifest?.rules?.length) manifest.rules = oldManifest.rules

  // 写入 manifest.json
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)

  // 更新缓存
  writeCache(cacheFile, { version: 1, pages: newCachePages })

  return manifest
}

/**
 * Vite 插件：wcManifestPlugin
 * - build: closeBundle 钩子生成 manifest
 * - dev: watch wc.pages.json + 页面组件源码变化 → 增量重生成
 */
export function wcManifestPlugin(userOptions: WcManifestOptions = {}): import('vite').Plugin {
  const options: Required<WcManifestOptions> = {
    configPath: userOptions.configPath ?? WC_PAGES_FILE,
    outPath: userOptions.outPath ?? '',
    noAi: userOptions.noAi ?? false,
    cacheFile: userOptions.cacheFile ?? '',
    aiCacheFile: userOptions.aiCacheFile ?? '',
    tsconfigPath: userOptions.tsconfigPath ?? '',
    watch: userOptions.watch ?? true,
    ai: userOptions.ai ?? {},
  }

  let root = process.cwd()
  let isBuild = false

  return {
    name: 'webassistant:wc-manifest',
    enforce: 'post',

    configResolved(resolvedConfig) {
      root = resolvedConfig.root
      isBuild = resolvedConfig.command === 'build'
      const env = loadEnv(resolvedConfig.mode, root, '')
      options.ai = {
        apiKey: userOptions.ai?.apiKey ?? env.DEEPSEEK_API_KEY,
        baseUrl: userOptions.ai?.baseUrl ?? env.DEEPSEEK_BASE_URL,
        model: userOptions.ai?.model ?? env.DEEPSEEK_MODEL,
      }
      // 规范化 outPath / cacheFile / aiCacheFile 为绝对路径
      if (!options.outPath) {
        const configPathAbs = path.resolve(root, options.configPath)
        options.outPath = path.join(path.dirname(configPathAbs), MANIFEST_FILE)
      } else {
        options.outPath = path.resolve(root, options.outPath)
      }
      if (!options.cacheFile) options.cacheFile = path.resolve(root, '.wc-manifest-cache.json')
      if (!options.aiCacheFile) options.aiCacheFile = path.resolve(root, '.analyze-cache.json')
    },

    // Build 结束时生成 manifest
    async closeBundle() {
      if (!isBuild) return
      try {
        await generateManifestIncremental(root, options)
        console.log(`✅ [wc-manifest] Generated ${path.relative(root, options.outPath)}`)
      } catch (err) {
        console.error(`❌ [wc-manifest] Failed to generate manifest:`, err)
      }
    },

    // Dev 模式：监听文件变化增量更新
    configureServer(server) {
      if (isBuild || !options.watch) return

      const configPathAbs = path.resolve(root, options.configPath)
      let currentConfig: (WcPagesConfig & { framework: string }) | null = null
      let ruleWatchPaths: string[] = []

      const reloadConfig = (): void => {
        try {
          currentConfig = loadWcPages(root, options.configPath)
          // 重新添加所有组件监听
          for (const page of currentConfig.pages) {
            const componentPath = path.resolve(root, page.component)
            if (fs.existsSync(componentPath)) {
              server.watcher.add(componentPath)
            }
          }
          // 重新添加规则文件/目录监听（wc.pages.json 的 rules 声明：manifest 级 + 页面级）
          ruleWatchPaths = collectConfigRuleWatchPaths(root, currentConfig)
          for (const rulePath of ruleWatchPaths) {
            if (fs.existsSync(rulePath)) server.watcher.add(rulePath)
          }
        } catch (err) {
          console.warn('[wc-manifest] Failed to reload wc.pages.json:', err)
        }
      }
      reloadConfig()

      // 监听 wc.pages.json 变化
      server.watcher.add(configPathAbs)

      server.watcher.on('change', async (file) => {
        const normalized = path.normalize(file)
        // wc.pages.json 变化 → 重新加载配置、重新监听组件，然后整体增量
        if (normalized === configPathAbs) {
          reloadConfig()
        }
        // 组件源码 / 规则文件变化（或 wc.pages.json 变化）→ 增量重生成
        const isComponent = currentConfig?.pages.some(
          (p) => path.resolve(root, p.component) === normalized,
        )
        const isRule = ruleWatchPaths.some(
          (rulePath) => normalized === rulePath || normalized.startsWith(rulePath + path.sep),
        )
        if (normalized === configPathAbs || isComponent || isRule) {
          try {
            await generateManifestIncremental(root, options)
            console.log(
              `🔄 [wc-manifest] Updated ${path.relative(root, options.outPath)} (triggered by ${path.relative(root, normalized)})`,
            )
          } catch (err) {
            console.error('[wc-manifest] Incremental update failed:', err)
          }
        }
      })
    },
  }
}
