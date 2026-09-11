// 生成页面入口文件。Vite library 模式不支持虚拟模块作 entry，所以写成真实文件缓存到
// node_modules/.wc-entry/。入口契约（与 wc-runtime-core 的 PageModule 对齐）：
//   export const styles: string[]                 —— custom-element 编译产出的 <style>
//   export default (api) => definePage(Page, api) —— runtime 注册页面时调用
import fs from 'node:fs'
import path from 'node:path'

export interface PageEntryInput {
  /** 已解析成绝对路径或裸包名的页面组件说明符 */
  component: string
  /** definePage 的来源（包名或路径） */
  pageHelper: string
  tag: string
}

export function pageEntrySource({ component, pageHelper, tag }: PageEntryInput): string {
  return `// 由 @webassistant/vite-plugin-wc 生成，请勿手改（tag: ${tag}）
import Page from ${JSON.stringify(component)}
import { definePage } from ${JSON.stringify(pageHelper)}

// styles = 页面自身样式（Page.styles）+ 依赖树里共享组件的样式。
// JSON.parse("__WC_PAGE_STYLES_JSON__") 是构建期占位，wcBuildPlugin 会替换成真实数组。
export const styles = [...(Page.styles || []), ...JSON.parse("__WC_PAGE_STYLES_JSON__")]

export function definePageElement(api) {
  return definePage(Page, api)
}
export default definePageElement
`
}

/** 清空并重建入口缓存目录 */
export function prepareEntryDir(dir: string): string {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function writeEntry(dir: string, fileName: string, source: string): string {
  const file = path.join(dir, fileName)
  fs.writeFileSync(file, source)
  return file
}
