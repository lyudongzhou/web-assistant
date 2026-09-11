import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, fetch as undiciFetch, type Response } from 'undici'
import type {
  AgentSession,
  ManifestPage,
  PageObservation,
  RuntimeManifest,
} from '@webassistant/protocol'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** 远程 manifest 来源（如 http://localhost:5778/wc/manifest.json）；配置后优先于 MANIFEST_PATH */
const MANIFEST_URL = process.env.MANIFEST_URL || ''

/** 远端拉取超时（ms），避免启动时因迟迟无响应而挂死 */
const FETCH_TIMEOUT_MS = Number(process.env.MANIFEST_FETCH_TIMEOUT_MS || 8_000)

/** 远程 manifest 刷新/重试间隔（ms）。启动未拉到会按此间隔重试，拉到后也会按此间隔更新。 */
const REFRESH_INTERVAL_MS = Number(process.env.MANIFEST_REFRESH_INTERVAL_MS || 60_000)

/** 内网 manifest 若为自签 HTTPS（如 https://172.16.21.200:19101），
 *  设 MANIFEST_INSECURE_TLS=1 时跳过 TLS 校验（仅影响 manifest 拉取，不影响 DeepSeek）。 */
const INSECURE_TLS = process.env.MANIFEST_INSECURE_TLS === '1'

/** 未拉到 manifest 时的空兜底：允许服务先启动，agent 侧暂无可用页面 */
const EMPTY_MANIFEST: RuntimeManifest = { version: 2, containers: {}, pages: [] }

@Injectable()
export class ManifestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManifestService.name)
  private manifest: RuntimeManifest = EMPTY_MANIFEST
  private manifestPath = ''
  private loadedMtimeMs = -1
  private refreshTimer: null | ReturnType<typeof setInterval> = null

  async onModuleInit(): Promise<void> {
    if (MANIFEST_URL) {
      // 远程来源：启动先尝试拉取一次（失败不阻断启动，带空 manifest 起来），
      // 之后按 REFRESH_INTERVAL_MS 定期刷新：未拉到会不断重试，拉到后持续更新。
      await this.tryLoadRemote()
      this.refreshTimer = setInterval(() => {
        void this.tryLoadRemote()
      }, REFRESH_INTERVAL_MS)
    } else {
      // 本地文件来源：保留原有的启动加载 + mtime 热重载。
      this.reloadFileIfChanged(true)
    }
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  getManifest(): RuntimeManifest {
    // 远程来源在 onModuleInit 已同步拉取完成，之后的读取直接拿缓存；
    // 本地文件来源保留 mtime 热重载，保证改动能被实时感知。
    if (!MANIFEST_URL) this.reloadFileIfChanged()
    return this.manifest
  }

  getManifestVersion(): number {
    return this.getManifest().version
  }

  getPages(): readonly ManifestPage[] {
    return this.getManifest().pages
  }

  getPage(tag: string): ManifestPage | undefined {
    return this.getPages().find((page) => page.tag === tag)
  }

  buildAgentContext(session?: Pick<AgentSession, 'currentPage' | 'pageExposedKeys' | 'recentObservations'>): string {
    const manifest = this.getManifest()
    const lines = ['你是一个网页助手，需要根据用户目标选择并操作页面。', '', '可用页面：']
    for (const page of manifest.pages) {
      lines.push(`- <${page.tag}> ${page.title || page.name}（${page.path}）`)
      if (page.description) lines.push(`  功能：${page.description}`)
      if (page.keywords?.length) lines.push(`  关键词：${page.keywords.join('、')}`)
      if (page.params?.length) {
        lines.push(`  必要/可用路由参数：${page.params.map((item) => `${item.name}(${item.type})`).join('、')}`)
      }
      if (page.props?.length) {
        lines.push(`  可传 props：${page.props.map((item) => `${item.name}(${item.type})${item.description ? `：${item.description}` : ''}`).join('；')}`)
      }
      if (page.events?.length) lines.push(`  页面事件：${page.events.join('、')}`)
      // 新增：expose（call_page_method 工具的能力清单）
      if (page.exposes?.length) {
        lines.push(
          `  可调用方法：${page.exposes
            .map((m) => `${m.name}${m.signature || '()'}${m.description ? `（${m.description}）` : ''}`)
            .join('；')}`,
        )
      }
      // 新增：emits（page.emit 通知面）—— 只读观察，agent 不能主动触发
      if (page.emits?.length) {
        lines.push(
          `  页面会发出的事件（只读观察，agent 不能主动触发）：${page.emits
            .map((e) => `${e.name}${e.payloadType ? `<${e.payloadType}>` : ''}${e.description ? `（${e.description}）` : ''}`)
            .join('；')}`,
        )
      }
      // dataSources：告诉 agent 这个页面打开后能通过 apiBus 上报什么数据
      if (page.dataSources?.length) {
        for (const ds of page.dataSources) {
          const fieldInfo = ds.fields ? ` 字段：${ds.fields.join('、')}` : ''
          const pkInfo = ds.primaryKey ? ` 主键：${ds.primaryKey}` : ''
          lines.push(`  可获取数据：${ds.description || ds.match}${fieldInfo}${pkInfo}`)
        }
      }
    }
    lines.push('', '规则：')
    lines.push('1. 页面参数缺失时，先寻找能通过 props 缩小范围的候选页面。')
    lines.push('2. render 的 ack 是 { status: "done" }，只表示导航请求已被受理，不代表页面或接口已经完成。')
    lines.push('3. 需要事实时等待页面观察结果；请求失败、空结果或超时都不能猜测业务参数。')
    lines.push('4. 只有观察结果明确出现的 id 才能用于后续详情页导航。')
    lines.push('5. 当前页有可调用方法时，优先用 call_page_method 精准操作（不要为了换状态重新 render 整个页面）。')
    lines.push('6. call_page_method 成功时 ack 为 { status: "success", value? }（Promise 会等 resolve；非 Promise 立即返回），可作为后续观察/推理的事实依据；失败为 ok:false + error。')
    lines.push('7. 方法签名里出现的参数必须放进 call_page_method 的 args（按签名顺序），缺失会以 undefined 调用而失败；无参数的方法可省略 args。')
    lines.push('   例：call_page_method({ name: "setKeyword", args: ["钱"] })；call_page_method({ name: "save", args: [{ name: "新数据源", host: "127.0.0.1" }] })')

    // 当前页 + 最新 expose 能力（运行时维度）
    if (session?.currentPage) {
      const tag = session.currentPage.tag
      const runtimeKeys = session.pageExposedKeys?.[tag]
      const manifestMethods = manifest.pages.find((p) => p.tag === tag)?.exposes
      if (runtimeKeys?.length || manifestMethods?.length) {
        lines.push('', `[当前页 <${tag}> 可用方法]`)
        const fromManifest = new Map((manifestMethods ?? []).map((m) => [m.name, m]))
        const seen = new Set<string>()
        // 运行时 keys 优先（反映页面真实暴露面），合并 manifest 描述
        const order: string[] = []
        for (const k of runtimeKeys ?? []) { order.push(k); seen.add(k) }
        for (const m of manifestMethods ?? []) if (!seen.has(m.name)) order.push(m.name)
        for (const name of order) {
          const m = fromManifest.get(name)
          lines.push(`  - ${name}${m?.signature || '()'}${m?.description ? `：${m.description}` : ''}`)
        }
        lines.push('  （调用方式：call_page_method({ name: "<方法名>", args: [按上面签名顺序传实参] })；签名带参数的方法必须给 args）')
      }
    }

    const recentObservations = session?.recentObservations
    if (recentObservations && recentObservations.length > 0) {
      lines.push('', '最近页面观察结果（来自当前 Session）：')
      for (const obs of recentObservations.slice(-20)) {
        if (obs.type === 'page.network.request') {
          lines.push(`  [网络请求] ${obs.method} ${obs.url} — 请求中${obs.page ? `（页面：${obs.page}）` : ''}`)
        } else if (obs.type === 'page.network.response') {
          const status = 'status' in obs ? obs.status : '?'
          const dataPreview = 'data' in obs && obs.data !== undefined
            ? ` 数据：${JSON.stringify(obs.data).slice(0, 500)}`
            : ''
          lines.push(`  [网络响应] ${obs.method} ${obs.url} → ${status}${dataPreview}${obs.page ? `（页面：${obs.page}）` : ''}`)
        } else if (obs.type === 'page.network.error') {
          lines.push(`  [网络错误] ${obs.method} ${obs.url} ✘ ${obs.error}${obs.page ? `（页面：${obs.page}）` : ''}`)
        } else if (obs.type === 'page.network.timeout') {
          lines.push(`  [网络超时] ${obs.method} ${obs.url} ⏱${obs.page ? `（页面：${obs.page}）` : ''}`)
        } else if (obs.type === 'page.data') {
          // 方案 B 核心：页面手动上报的数据快照，agent 可直接读取
          const dataPreview = JSON.stringify(obs.data).slice(0, 800)
          lines.push(`  [页面数据] 来源：${obs.source}${obs.page ? `（页面：${obs.page}）` : ''} 数据：${dataPreview}`)
        } else if (obs.type === 'page.emit') {
          const payloadPreview = obs.payload !== undefined
            ? ` 载荷：${JSON.stringify(obs.payload).slice(0, 500)}`
            : ''
          lines.push(`  [页面事件] ${obs.event}${payloadPreview}${obs.page ? `（页面：${obs.page}）` : ''}`)
        }
      }
    }

    return lines.join('\n')
  }

  /** 远程拉取一次，失败仅告警、不抛出（保证 manifest 拉取失败不会拖垮服务）。 */
  private async tryLoadRemote(): Promise<void> {
    try {
      await this.loadRemote()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const empty = this.manifest.pages.length === 0
      this.logger.warn(
        empty
          ? `[manifest] 远程拉取失败：${reason}；${Math.round(REFRESH_INTERVAL_MS / 1000)} 秒后重试`
          : `[manifest] 刷新失败：${reason}；沿用旧版本（${this.manifest.pages.length} 页）`,
      )
    }
  }

  /** 远程拉取一次。成功写入内存缓存；任何一步失败都抛出，由 tryLoadRemote 兜底。 */
  private async loadRemote(): Promise<void> {
    const url = MANIFEST_URL
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    const dispatcher = INSECURE_TLS
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined
    try {
      res = await undiciFetch(url, { signal: controller.signal, dispatcher })
    } catch (cause) {
      const reason = cause instanceof Error && cause.name === 'AbortError'
        ? `请求超时（>${FETCH_TIMEOUT_MS}ms）`
        : cause instanceof Error ? cause.message : String(cause)
      throw new Error(`manifest 远程拉取失败：${url} —— ${reason}`)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      throw new Error(`manifest 远程拉取失败：${url} —— HTTP ${res.status}`)
    }
    try {
      const parsed: unknown = JSON.parse(await res.text())
      this.storeManifest(parsed, url)
    } catch (cause) {
      throw new Error(`manifest 拉取自 ${url} 但解析失败：${(cause as Error).message}`)
    }
  }

  private reloadFileIfChanged(force = false): void {
    const filePath = this.resolveManifestPath()
    const mtimeMs = statSync(filePath).mtimeMs
    if (!force && this.manifest && filePath === this.manifestPath && mtimeMs === this.loadedMtimeMs) return

    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    this.storeManifest(parsed, filePath)
    this.loadedMtimeMs = mtimeMs
  }

  private storeManifest(parsed: unknown, source: string): void {
    this.manifest = this.validateManifest(parsed)
    this.manifestPath = source
    this.logger.debug(
      `manifest loaded from ${source}（version=${this.manifest.version}，pages=${this.manifest.pages.length}）`,
    )
  }

  private resolveManifestPath(): string {
    return process.env.MANIFEST_PATH || path.resolve(moduleDir, '../../../demo-app/manifest.json')
  }

  private validateManifest(value: unknown): RuntimeManifest {
    if (!value || typeof value !== 'object') throw new Error('manifest must be an object')
    const candidate = value as Partial<RuntimeManifest>
    if (candidate.version !== 2) throw new Error(`unsupported manifest version: ${String(candidate.version)}`)
    if (!Array.isArray(candidate.pages) || candidate.pages.length === 0) throw new Error('manifest.pages must not be empty')
    for (const page of candidate.pages) {
      if (!page || typeof page !== 'object' || typeof page.tag !== 'string' || !page.tag) {
        throw new Error('manifest page.tag is required')
      }
      if (typeof page.name !== 'string' || typeof page.bundle !== 'string') {
        throw new Error(`manifest page ${page.tag} requires name and bundle`)
      }
    }
    return candidate as RuntimeManifest
  }
}
