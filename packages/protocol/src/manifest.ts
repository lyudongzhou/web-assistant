// manifest v2 —— analyzer 产出、runtime 消费、agent-server 读取的线上格式。
// bundle 路径是「相对产物根」的，运行时由 runtime 的 assetBase 拼成可加载 URL。

export const MANIFEST_VERSION = 2 as const
export const MANIFEST_FILE = 'manifest.json'

export interface ManifestParam {
  name: string
  type: string
  /**
   * 下发通道（缺省 `path`，path 参数**不写**该字段）：
   * - `path`：路由段 `:name` —— vue-router 解析进 `route.params`
   * - `query`：URL `?name=` —— 进 `route.query`（**路径外的键值只能走这条通道**）
   *
   * 由 analyzer 从「路由 path 正则」与「页面源码里 `route.query.x` 的读取」两处推断
   * （见 `packages/analyzer/src/routeScan.ts`）：agent 无需关心通道，统一放进 render 的 `params`，
   * runtime 按本字段分流到 `route.params` / `route.query`。
   */
  in?: 'path' | 'query'
  /** 参数说明（query 参数常由 JSDoc / AI 补全；供 agent 规划参考） */
  description?: string
}

export interface ManifestProp {
  name: string
  type: string
  description?: string
}

/**
 * 页面可上报的数据源声明（agent 规划依据 + runtime 摘要白名单）。
 * match 命中 → runtime 把该请求的响应按 fields/mask/maxRows 摘要后上报给 agent。
 */
export interface ManifestDataSource {
  /** 数据源唯一标识（通常就是 URL 或路径，如 /api/users） */
  match: string
  /** 可上报字段白名单；缺省 = 全部字段（谨慎） */
  fields?: string[]
  /** 数组响应最多取多少行（缺省 20） */
  maxRows?: number
  /** 敏感字段脱敏（值替换为 '***'）；缺省不脱敏 */
  mask?: string[]
  /** 说明这段数据是干什么的（供 agent 规划） */
  description?: string
  /** 主键字段名（agent 提取 id 的参考） */
  primaryKey?: string
}

export interface ManifestPage {
  tag: string
  name: string
  path: string
  title?: string
  /** 所属框架批次，决定用哪个容器渲染 */
  framework: string
  /**
   * 页面 bundle 相对路径，如 pages/userList.js。
   * **宿主直连模式（host）没有 bundle** —— 页面是宿主自己的路由组件，不经产物编译。
   */
  bundle?: string
  params?: ManifestParam[]
  props?: ManifestProp[]
  events?: string[]
  /** 以下三项由 analyzer 的静态解析 + AI 语义分析产出，供 agent 匹配意图 */
  description?: string
  keywords?: string[]
  exampleQueries?: string[]
  /**
   * 页面级 agent 规则（仅在该页面生效；随 manifest 下发）。
   * 由 `wc.pages.json` 页面条目的 `rules` 声明，analyzer / wcManifestPlugin 自动收集。
   */
  rules?: ManifestRule[]
  /** 页面可上报的数据源（agent 规划依据 + runtime 摘要白名单） */
  dataSources?: ManifestDataSource[]
  /**
   * 页面通过 `defineExpose` 暴露的方法（agent 可通过 call_page_method 调用）。
   * analyzer 静态解析，不解析函数体；signature/description 由 JSDoc 推断。
   */
  exposes?: ManifestMethod[]
  /**
   * 页面通过 Vue `defineEmits` 声明的事件（agent 通过 page.emit 接收）。
   * analyzer 静态解析事件名；payloadType MVP 可省略。
   */
  emits?: ManifestEvent[]
  meta?: Record<string, unknown>
}

/**
 * 页面 expose 方法的元数据（agent 规划与调用合同）。
 * signature / description 为可选，缺失时 prompt 里仅展示名字。
 */
export interface ManifestMethod {
  name: string
  /** 形如 `(args: { status: 'paid' | 'all' }) => void` 的简要签名描述（analyzer 推断） */
  signature?: string
  description?: string
}

/** 页面 emit 事件的元数据（agent 通知面参考）。 */
export interface ManifestEvent {
  name: string
  /** 载荷类型描述（如 `unknown[]` / `{ id: string }`），MVP 可缺省 */
  payloadType?: string
  description?: string
}

/**
 * 项目级 agent 规则（随 manifest 一同下发）。
 *
 * 粒度是 **manifest 级**：一波页面（一个 manifest）共享一波规则。
 * 由 `wc.pages.json` 的 `rules` 声明，analyzer / wcManifestPlugin 自动收集正文并内联进 manifest，
 * agent-server 读取后注入 system prompt。
 * 字段名对齐 Cline SDK 的 `RuleConfig`（name / disabled / instructions），便于后续扩展。
 */
export interface ManifestRule {
  /** 规则名（文件基名或显式 name），用于日志/调试与去重 */
  name: string
  /** 规则正文（Markdown） */
  instructions: string
  /** 是否禁用（保留在 manifest 中但不注入 prompt） */
  disabled?: boolean
}

export interface ManifestContainer {
  /** 容器 bundle 相对路径，如 containers/vue.js */
  bundle: string
  /** 容器自定义元素标签，缺省 runtime-<framework> */
  tagName?: string
}

/** analyzer 写出的严格格式 */
export interface RuntimeManifest {
  version: typeof MANIFEST_VERSION
  containers: Record<string, ManifestContainer>
  styles?: { shared?: string[] }
  /** 项目级 agent 规则（可选；随 manifest 下发，agent-server 注入 system prompt） */
  rules?: ManifestRule[]
  pages: ManifestPage[]
}

/** runtime 接受的宽松输入（手写 manifest / 预注册 adapter 场景可省字段） */
export interface RuntimeManifestInput {
  version?: number
  containers?: Record<string, { bundle?: string; tagName?: string }>
  styles?: { shared?: string[] }
  pages?: Array<{
    tag?: string
    name: string
    path?: string
    title?: string
    framework?: string
    /** 宿主直连模式可省（页面不经 bundle 渲染） */
    bundle?: string
    params?: ManifestParam[]
    props?: ManifestProp[]
    events?: string[]
    description?: string
    keywords?: string[]
    exampleQueries?: string[]
    dataSources?: ManifestDataSource[]
    meta?: Record<string, unknown>
  }>
}
