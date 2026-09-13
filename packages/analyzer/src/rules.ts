// 规则收集：把 wc.pages.json 的 `rules` 声明（文件/目录路径或内联正文）解析成 manifest.rules。
// analyzer 与 vite-plugin-wc 共用本文件，保证两条 manifest 生成路径产出一致（不漂移）。
import fs from 'node:fs'
import path from 'node:path'
import type { ManifestRule, WcPagesConfig, WcRuleEntry } from '@webassistant/protocol'

const MD_EXTENSION = /\.md$/i
/** 只认顶部的 YAML frontmatter（扁平 key: value 足够，避免引入 YAML 依赖） */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

interface ParsedMarkdown {
  data: Record<string, string>
  body: string
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/** 解析 Markdown 顶部 frontmatter，返回 { data, body }；无 frontmatter 时 data 为空、body 原样 */
export function parseRuleMarkdown(content: string): ParsedMarkdown {
  const match = content.match(FRONTMATTER)
  if (!match) return { data: {}, body: content }
  const data: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sep = trimmed.indexOf(':')
    if (sep <= 0) continue
    data[trimmed.slice(0, sep).trim()] = stripQuotes(trimmed.slice(sep + 1).trim())
  }
  return { data, body: content.slice(match[0].length) }
}

/** frontmatter.name/disabled 覆盖缺省 name；正文去掉 frontmatter */
function toRule(fallbackName: string, content: string): ManifestRule {
  const { data, body } = parseRuleMarkdown(content)
  const name = data.name?.trim() || fallbackName
  const disabled = data.disabled === 'true'
  return { name, instructions: body.trim(), ...(disabled ? { disabled: true } : {}) }
}

function readRuleFile(filePath: string): ManifestRule | null {
  try {
    return toRule(path.basename(filePath).replace(MD_EXTENSION, ''), fs.readFileSync(filePath, 'utf-8'))
  } catch (cause) {
    console.warn(`  ⚠️ 读取规则文件失败：${filePath} —— ${(cause as Error).message}`)
    return null
  }
}

/**
 * 把 wc.pages.json 的 `rules` 声明收集成 `ManifestRule[]`。
 * - 字符串路径：文件 → 读该文件；目录 → 自动收集目录下所有 `.md`（按文件名排序，产物稳定）
 * - 内联对象：`{ name?, content }`
 * - 同名规则保留首次出现（后者跳过）
 * 声明为空 / 全部找不到时返回 `[]`（调用方据此决定是否写 `manifest.rules`）。
 */
export function resolveRuleEntries(root: string, entries: WcRuleEntry[] | undefined): ManifestRule[] {
  if (!entries?.length) return []
  const rules: ManifestRule[] = []
  const seen = new Set<string>()
  const push = (rule: ManifestRule | null): void => {
    if (!rule) return
    const key = rule.name || `rule-${rules.length + 1}`
    if (seen.has(key)) {
      console.warn(`  ⚠️ 规则名重复，跳过：${key}`)
      return
    }
    seen.add(key)
    rules.push(rule)
  }

  for (const entry of entries) {
    if (typeof entry === 'string') {
      const target = path.resolve(root, entry)
      let stat: fs.Stats
      try {
        stat = fs.statSync(target)
      } catch {
        console.warn(`  ⚠️ 找不到规则文件/目录：${target}`)
        continue
      }
      if (stat.isDirectory()) {
        const files = fs.readdirSync(target).filter((name) => MD_EXTENSION.test(name)).sort()
        if (!files.length) console.warn(`  ⚠️ 规则目录内没有 .md 文件：${target}`)
        for (const name of files) push(readRuleFile(path.join(target, name)))
      } else {
        push(readRuleFile(target))
      }
    } else if (entry && typeof entry.content === 'string') {
      push(toRule(entry.name?.trim() || `inline-${rules.length + 1}`, entry.content))
    }
  }
  return rules
}

/** 收集规则声明涉及的绝对路径（文件与目录），供 vite dev watch 使用 */
export function collectRuleWatchPaths(root: string, entries: WcRuleEntry[] | undefined): string[] {
  if (!entries?.length) return []
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => path.resolve(root, entry))
}

/**
 * 收集整个 wc.pages.json 涉及的规则待监听路径：**manifest 级 + 每个页面级**。
 * 供 `wcManifestPlugin` 的 dev watch 使用（页面级规则文件改动也要触发增量重生成）。
 */
export function collectConfigRuleWatchPaths(
  root: string,
  config: Pick<WcPagesConfig, 'rules' | 'pages'>,
): string[] {
  const paths = collectRuleWatchPaths(root, config.rules)
  for (const page of config.pages ?? []) {
    paths.push(...collectRuleWatchPaths(root, page.rules))
  }
  return paths
}
