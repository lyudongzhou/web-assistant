// 读取并校验 wc.pages.json（schema 定义在 @webassistant/protocol，与 analyzer 共用）。
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_FRAMEWORK,
  DEFAULT_PAGE_HELPER,
  WC_PAGES_FILE,
  resolveTag,
  type WcPagesConfig,
} from '@webassistant/protocol'

export interface LoadedConfig extends WcPagesConfig {
  framework: string
  pageHelper: string
}

export function loadWcPages(root: string, configPath = WC_PAGES_FILE): LoadedConfig {
  const file = path.resolve(root, configPath)
  let raw: WcPagesConfig
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as WcPagesConfig
  } catch (cause) {
    throw new Error(`读取 ${file} 失败：${(cause as Error).message}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`${file} 必须是对象`)
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
    throw new Error(`${file} 的 pages 不能为空`)
  }
  // container 省略 = 宿主直连批次（用法 B）：只生成页面目录，不构建 WC。
  // WC 构建侧（wcVuePlugin / wcBuildPlugin）会自己要求它存在（见 entries）。

  const seen = new Set<string>()
  for (const [index, page] of raw.pages.entries()) {
    if (!page?.name) throw new Error(`${file} pages[${index}] 缺少 name`)
    if (!page.component) throw new Error(`${file} pages[${index}](${page.name}）缺少 component`)
    const tag = resolveTag(page)
    if (!tag.includes('-')) {
      throw new Error(`${file} 页面 ${page.name} 的 tag「${tag}」必须包含 '-'（自定义元素规范）`)
    }
    if (seen.has(tag)) throw new Error(`${file} 存在重复的 tag：${tag}`)
    seen.add(tag)
  }

  return {
    ...raw,
    framework: raw.framework || DEFAULT_FRAMEWORK,
    pageHelper: raw.pageHelper || DEFAULT_PAGE_HELPER,
  }
}
