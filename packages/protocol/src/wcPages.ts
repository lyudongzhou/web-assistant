// wc.pages.json v2 —— 一个 framework 批次的构建清单，是「唯一真相来源」：
// vite-plugin-wc 读它决定怎么打包，analyzer 读它生成 manifest。
// 命名规则（tag / 入口名 / 产物路径）统一放在本文件，避免插件与 analyzer 各算一套导致漂移。

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
}

export interface WcPagesConfig {
  /** 该批次的框架，决定容器 adapter 与产物名；缺省 vue */
  framework?: string
  /** 容器入口文件路径（默认导出 adapter），构建成 containers/<framework>.js */
  container: string
  /** 页面注册助手（包名或路径）；缺省 @webassistant/wc-runtime-vue */
  pageHelper?: string
  /** 跨容器共享样式（构建产物内的相对路径），写进 manifest.styles.shared */
  sharedStyles?: string[]
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
