// wc.pages.json v2 —— 一个 framework 批次的构建清单，是「唯一真相来源」：
// vite-plugin-wc 读它决定怎么打包，analyzer 读它生成 manifest。
// 命名规则（tag / 入口名 / 产物路径）统一放在本文件，避免插件与 analyzer 各算一套导致漂移。
import type { ManifestDataSource, ManifestParam } from './manifest.js'

export interface WcPageEntry {
  /** 路由名（PascalCase），供 router.push({ name }) 使用 */
  name: string
  /** 自定义元素标签；缺省由 name 推导 kebab-case，必须含 '-' */
  tag?: string
  /** 路由路径，支持 :param；缺省 /<tag> */
  path?: string
  title?: string
  /** 页面组件路径：相对项目根 / 别名（#、@）/ 裸包名 */
  component: string
  /**
   * 页面入参的**显式**声明（逃生口，通道固定为 `query`；声明里不要写 `in`）。
   *
   * analyzer 会从页面源码自动探测 `route.query.x` 的读取（见 `packages/analyzer/src/routeScan.ts`），
   * 所以这里**通常不用写**。只有三类情况需要：动态键（`route.query[key]`）、整块读（`{ ...route.query }`）、
   * 读 query 的逻辑封装在别的文件里（探测不到）；或者想给参数补/覆盖说明与类型（显式优先于探测）。
   */
  query?: Array<Omit<ManifestParam, 'in'>>
  /**
   * 页面级 agent 规则 —— 只在该页面生效（与 manifest 级 rules 同款声明，见 {@link WcRuleEntry}）。
   * analyzer / wcManifestPlugin 自动收集进 `manifest.pages[].rules`。
   */
  rules?: WcRuleEntry[]
  /**
   * 页面可上报的数据源声明 —— 原样写进 `manifest.pages[].dataSources`（单一来源，避免手改产物）。
   *
   * 语义是「声明 + 有界裁剪」：
   * - agent 侧：prompt 里预先声明该页能拿到什么数据（planning 依据）
   * - runtime 侧：`apiBus.report({ url })` 命中 `match` 时，按 `fields` / `maxRows` / `mask` 摘要后才出网；
   *   未命中 → 原样透传（调用点已显式决定报什么）
   *
   * 注意：声明 ≠ 自动上报。runtime 零采集，仍需调用点显式 `apiBus.report`。
   */
  dataSources?: ManifestDataSource[]
}

/**
 * 规则文档声明：项目内 Markdown 文件/目录路径（相对项目根），或内联正文。
 * - `string`：路径；指向文件时读该文件，指向目录时**自动收集**目录下所有 `.md`（按文件名排序）
 * - `{ name?, content }`：内联规则正文（可不落文件）
 *
 * Markdown 顶部可选 YAML frontmatter（`name` / `disabled`），见 {@link WcPagesConfig.rules}。
 */
export type WcRuleEntry = string | { name?: string; content: string }

export interface WcPagesConfig {
  /** 该批次的框架，决定容器 adapter 与产物名；缺省 vue */
  framework?: string
  /**
   * 容器入口文件路径（默认导出 adapter），构建成 containers/<framework>.js。
   *
   * **可省略**：省略即「宿主直连批次（用法 B）」—— 页面不编译成 WC、不需要容器，
   * 只用来生成页面目录（manifest）：此时 analyzer / wcManifestPlugin 不写 `containers` 与 `pages[].bundle`；
   * `wcVuePlugin` / `wcBuildPlugin`（WC 构建）仍**要求**声明 container。
   */
  container?: string
  /** 页面注册助手（包名或路径）；缺省 @webassistant/wc-runtime-vue */
  pageHelper?: string
  /** 跨容器共享样式（构建产物内的相对路径），写进 manifest.styles.shared */
  sharedStyles?: string[]
  /**
   * 本批次（本 manifest）共享的 agent 规则 —— 一波页面一波规则。
   * analyzer / wcManifestPlugin 自动收集正文并内联进 `manifest.rules`（供 agent-server 注入 prompt）。
   * 规则 Markdown 顶部可选 frontmatter：`--- name: xxx / disabled: true ---`。
   */
  rules?: WcRuleEntry[]
  pages: WcPageEntry[]
}

export const WC_PAGES_FILE = 'wc.pages.json'
export const DEFAULT_FRAMEWORK = 'vue'
export const DEFAULT_PAGE_HELPER = '@webassistant/wc-runtime-vue'
export const CONTAINER_DIR = 'containers'
export const PAGE_DIR = 'pages'
/** 容器入口在 vite lib.entry 里的键名 */
export const CONTAINER_ENTRY_KEY = '__wa_container'

/** PascalCase / camelCase → kebab-case：OntologyModeling → ontology-modeling */
export function toKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/** kebab-case → camelCase：app-dashboard → appDashboard */
export function kebabToCamel(input: string): string {
  return input.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
}

/** 页面的自定义元素标签：显式 tag 优先，否则由 name 推导 */
export function resolveTag(page: Pick<WcPageEntry, 'name' | 'tag'>): string {
  return page.tag || toKebab(page.name)
}

/** 页面 bundle 在产物里的相对路径：pages/appDashboard.js */
export function pageBundlePath(tag: string): string {
  return `${PAGE_DIR}/${kebabToCamel(tag)}.js`
}

/** 容器 bundle 在产物里的相对路径：containers/vue.js */
export function containerBundlePath(framework: string): string {
  return `${CONTAINER_DIR}/${framework}.js`
}

/** 容器自定义元素标签：runtime-vue */
export function containerTagName(framework: string): string {
  return `runtime-${framework}`
}
