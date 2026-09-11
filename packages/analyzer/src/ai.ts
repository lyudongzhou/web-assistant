// AI 语义分析：把「本地静态解析定稿的 PageFacts」（字段名/类型/签名已由 vue-tsc 内核展开）喂给 DeepSeek，
// 只让它补语义（description / keywords / exampleQueries + 缺 description 的字段与方法），
// 按 PageFacts hash 缓存，失败由调用方回退静态解析结果。
//
// 关键变化（design D4）：输入不再是原始源码，而是结构化 PageFacts —— token 更小、杜绝字段级幻觉，
// 同时坚持「本地先定稿、AI 只做语义」。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {
  ManifestDataSource,
  ManifestEvent,
  ManifestMethod,
  ManifestParam,
  ManifestProp,
} from '@webassistant/protocol'

const here = path.dirname(fileURLToPath(import.meta.url))

export interface AiOptions {
  /** DeepSeek/OpenAI-compatible API key；缺省读取宿主进程环境 */
  apiKey?: string
  /** API base URL；缺省读取宿主进程环境 */
  baseUrl?: string
  /** 模型名；缺省读取宿主进程环境 */
  model?: string
  /** AI 结果缓存文件 */
  cacheFile?: string
}

// 解析缓存路径优先级：显式参数 > ANALYZE_CACHE_FILE 环境变量 > analyzer 包内缺省
function getCachePath(cacheFile?: string): string {
  if (cacheFile) return path.resolve(cacheFile)
  if (process.env.ANALYZE_CACHE_FILE) return path.resolve(process.env.ANALYZE_CACHE_FILE)
  return path.resolve(here, '../.analyze-cache.json')
}

/**
 * 本地静态解析定稿的页面结构骨架（喂 AI 的唯一输入）。
 * 字段名 / 类型 / 签名由 vue-tsc 内核跨文件类型解析产出，是准确的；AI 不许改动它们。
 */
export interface PageFacts {
  /** 本地解析出的描述（@description 或兜底文案），供 AI 参考/改写 */
  description: string
  props: ManifestProp[]
  params: ManifestParam[]
  events: string[]
  emits: ManifestEvent[]
  exposes: ManifestMethod[]
  /** 手工在 wc.pages.json / 旧 manifest 维护的数据源白名单（analyzer 不产出，可为空） */
  dataSources?: ManifestDataSource[]
}

export interface AiPageInput {
  name: string
  path: string
  title?: string
  /** 结构化 PageFacts（替代原始源码：token 更小、字段准确） */
  facts: PageFacts
}

export interface AiPageResult {
  description: string
  keywords: string[]
  exampleQueries: string[]
  /** 补齐 props 里缺 description 的字段：{ 字段名: 说明 } */
  propDescriptions?: Record<string, string>
  /** 补齐 emits 里缺 description 的事件：{ 事件名: 说明 } */
  emitDescriptions?: Record<string, string>
  /** 补齐 exposes 里缺 description 的方法：{ 方法名: 说明 } */
  methodDescriptions?: Record<string, string>
}

type Cache = Record<string, AiPageResult>

function hash(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex').slice(0, 16)
}

function loadCache(cachePath: string): Cache {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Cache
  } catch {
    return {}
  }
}

function saveCache(cachePath: string, cache: Cache): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`)
}

/** 缓存 key：PageFacts（结构变了才重分析）+ 路由（path/title 变了描述也要重算） */
export function cacheKeyOf(page: AiPageInput): string {
  return hash(`${page.path}\n${page.title ?? ''}\n${JSON.stringify(page.facts)}`)
}

export function buildPrompt(page: AiPageInput): string {
  return [
    '你是前端页面语义分析助手。下面是本地静态分析（vue-tsc 内核跨文件类型解析）已经定稿的 PageFacts：',
    'props / emits 载荷 / exposes 签名里的字段名与类型都是准确的，不要改动、不要臆造不存在的字段或事件。',
    '',
    `路由信息：路径 ${page.path}，名称 ${page.name}，标题 ${page.title ?? ''}`,
    'PageFacts：',
    '```json',
    JSON.stringify(page.facts, null, 2),
    '```',
    '',
    '只做语义补全。严格返回 JSON（不要 markdown 代码块、不要多余解释），格式：',
    '{',
    '  "description": "一句话描述页面功能（面向用户，中文）",',
    '  "keywords": ["用户可能的意图关键词，3-8 个"],',
    '  "exampleQueries": ["用户可能说的话，2-4 句"],',
    '  "propDescriptions": { "props 里缺 description 的字段名": "一句话说明" },',
    '  "emitDescriptions": { "emits 里缺 description 的事件名": "一句话说明" },',
    '  "methodDescriptions": { "exposes 里缺 description 的方法名": "一句话说明" }',
    '}',
    '注意：三个 *Descriptions 的 key 必须来自上面 PageFacts 里已有的名字，只补 description 为空的项；',
    '没有需要补的就返回空对象 {}。',
  ].join('\n')
}

function parseJson(text: string): Record<string, unknown> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  return JSON.parse(cleaned) as Record<string, unknown>
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : []
}

/** 只保留 value 是非空字符串的 entry，避免 AI 回一个乱七八糟的结构污染 manifest */
function toStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && item.trim()) out[key] = item.trim()
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 把 AI 补的说明合并进静态解析结果：只动 description 为空的项，
 * 不覆盖 JSDoc / 静态解析已有的说明，也不改字段名与类型（AI 只能「填空」）。
 */
export function applyAiDescriptions<T extends { name: string; description?: string }>(
  items: T[],
  extra?: Record<string, string>,
): T[] {
  if (!extra) return items
  return items.map((item) => {
    if (item.description) return item
    const description = extra[item.name]
    return description ? { ...item, description } : item
  })
}

export async function analyzeWithAI(page: AiPageInput, options: AiOptions = {}): Promise<AiPageResult> {
  const cachePath = getCachePath(options.cacheFile)
  const cacheKey = cacheKeyOf(page)
  const baseUrl = options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
  const model = options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? ''
  const cache = loadCache(cachePath)
  const cached = cache[cacheKey]
  if (cached) return cached

  if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY（请在宿主项目 .env 或进程环境中配置）')

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是一个严谨的前端代码分析助手，只输出合法 JSON。' },
        { role: 'user', content: buildPrompt(page) },
      ],
      temperature: 0.2,
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM 请求失败：HTTP ${res.status} ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error('LLM 返回为空')

  const parsed = parseJson(content)
  const result: AiPageResult = {
    description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
    keywords: toStringList(parsed.keywords),
    exampleQueries: toStringList(parsed.exampleQueries),
    propDescriptions: toStringMap(parsed.propDescriptions),
    emitDescriptions: toStringMap(parsed.emitDescriptions),
    methodDescriptions: toStringMap(parsed.methodDescriptions),
  }
  if (!result.description) throw new Error('AI 返回缺少 description')

  cache[cacheKey] = result
  saveCache(cachePath, cache)
  return result
}
