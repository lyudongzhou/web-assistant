// manifest v2 归一化：把构建产物清单变成 core 的路由表 + 容器表 + 共享样式。
// 只支持 v2（研究阶段不背旧 schema）。schema 与命名规则由 @webassistant/protocol 定义，
// 与 vite-plugin-wc / analyzer 共用同一套，避免 tag / 产物路径两头各算一套。
import {
  MANIFEST_VERSION,
  containerTagName,
  resolveTag,
  type RuntimeManifestInput,
} from '@webassistant/protocol'
import { joinUrl } from './dom.js'
import type {
  ContainerDescriptor,
  NormalizedManifest,
  RouteParamDef,
  RuntimeRoute,
} from './types.js'

export type { RuntimeManifestInput }

/** 从路由 path 提取参数：/users/:id → [{ name: 'id', type: 'string' }] */
export function extractParams(path: string): RouteParamDef[] {
  const out: RouteParamDef[] = []
  for (const match of path.matchAll(/:([A-Za-z0-9_]+)/g)) out.push({ name: match[1], type: 'string' })
  return out
}

export interface NormalizeOptions {
  /** 产物根地址，用于把 bundle 相对路径拼成可加载 URL */
  assetBase?: string
  /** 预注册 adapter 的 framework 列表（这些 framework 不要求 containers 里有 bundle） */
  preRegisteredFrameworks?: readonly string[]
}

export function normalizeManifest(
  input: RuntimeManifestInput,
  options: NormalizeOptions = {},
): NormalizedManifest {
  if (!input || typeof input !== 'object') throw new TypeError('manifest 必须是对象')
  if (input.version !== MANIFEST_VERSION) {
    throw new Error(`不支持的 manifest 版本：${String(input.version)}，请使用 version: 2`)
  }

  const assetBase = options.assetBase
  const preRegistered = new Set(options.preRegisteredFrameworks ?? [])

  const containers: ContainerDescriptor[] = Object.entries(input.containers ?? {}).map(
    ([framework, def]) => ({
      framework,
      tagName: def?.tagName || containerTagName(framework),
      bundle: def?.bundle ? joinUrl(assetBase, def.bundle) : null,
    }),
  )
  const containerFrameworks = new Set(containers.map((c) => c.framework))
  const knownFrameworks = new Set([...containerFrameworks, ...preRegistered])
  const defaultFramework = containerFrameworks.size === 1 ? [...containerFrameworks][0] : undefined

  const pages = input.pages ?? []
  if (!pages.length) throw new Error('manifest.pages 不能为空')

  const seenTags = new Set<string>()
  const seenNames = new Set<string>()
  const routes: RuntimeRoute[] = pages.map((page, index) => {
    if (!page || !page.name) throw new Error(`manifest.pages[${index}] 缺少 name`)
    if (!page.bundle) throw new Error(`manifest.pages[${index}](${page.name}）缺少 bundle`)

    const tag = resolveTag(page)
    if (!tag.includes('-')) {
      throw new Error(`页面 ${page.name} 的 tag「${tag}」不合法：自定义元素标签必须包含 '-'`)
    }
    if (seenTags.has(tag)) throw new Error(`重复的 tag：${tag}`)
    if (seenNames.has(page.name)) throw new Error(`重复的路由名：${page.name}`)
    seenTags.add(tag)
    seenNames.add(page.name)

    const framework = page.framework || defaultFramework
    if (!framework) {
      throw new Error(
        `页面 ${page.name} 未声明 framework，且 manifest.containers 不止一个，无法推断`,
      )
    }
    if (!knownFrameworks.has(framework)) {
      throw new Error(
        `页面 ${page.name} 声明的 framework「${framework}」在 manifest.containers 中不存在，` +
          '且没有预注册对应 adapter',
      )
    }

    const path = page.path || `/${tag}`
    return {
      tag,
      name: page.name,
      path,
      title: page.title,
      framework,
      bundle: joinUrl(assetBase, page.bundle),
      params: page.params?.length ? page.params : extractParams(path),
      props: page.props ?? [],
      events: page.events ?? [],
      dataSources: page.dataSources,
      meta: { ...(page.meta ?? {}) },
    }
  })

  return {
    version: MANIFEST_VERSION,
    routes,
    containers,
    sharedStyles: (input.styles?.shared ?? []).map((file) => joinUrl(assetBase, file)),
  }
}

