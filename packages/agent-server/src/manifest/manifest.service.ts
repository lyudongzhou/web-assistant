import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, fetch as undiciFetch, type Response } from 'undici'
import type {
  AgentSession,
  ManifestPage,
  ManifestRule,
  PageObservation,
  RuntimeManifest,
  WelcomeCapability,
  WelcomePayload,
} from '@webassistant/protocol'
import { PLAN_HINT } from '../agent/mode.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 远程 manifest 来源（如 http://localhost:5778/wc/manifest.json）；配置后优先于 MANIFEST_PATH。
 *
 * ⚠️ 必须**懒读**：`--manifest-url` 是 `main.ts` 的 `applyCliArgs()` 写进 process.env 的，而它发生在
 * 模块求值**之后** —— 顶层 `const MANIFEST_URL = process.env.MANIFEST_URL` 会把 dotenv 的值快照下来，
 * 让命令行参数静默失效（启动日志却是运行时读的 → 打印你传的 URL、实际加载 .env 的地址，极难查）。
 */
const manifestUrl = (): string => process.env.MANIFEST_URL || ''

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
    if (manifestUrl()) {
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
    if (!manifestUrl()) this.reloadFileIfChanged()
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

  /** 项目级 agent 规则（随 manifest 下发；一波页面一波规则）。空数组表示该项目未声明规则。 */
  getRules(): readonly ManifestRule[] {
    return this.getManifest().rules ?? []
  }

  /**
   * 连接建立（session.hello）时的欢迎载荷：介绍 agent「能做什么」。
   * - `capabilities`：按 manifest 页面派生（纯数据，零 LLM 成本）
   * - `text`：欢迎语正文，`WELCOME_MESSAGE` 可整段覆盖
   * - `WELCOME_ENABLED=0`：关闭（返回 null）
   * 都在调用时读 process.env，便于运行时/测试按需切换。
   */
  buildWelcome(): WelcomePayload | null {
    if (process.env.WELCOME_ENABLED === '0') return null
    const capabilities: WelcomeCapability[] = this.getPages().map((page) => {
      const examples = page.exampleQueries?.length
        ? page.exampleQueries.slice(0, 2)
        : page.keywords?.slice(0, 3)
      return {
        tag: page.tag,
        name: page.name,
        ...(page.title ? { title: page.title } : {}),
        ...(page.description ? { description: page.description } : {}),
        ...(examples?.length ? { examples } : {}),
      }
    })
    const override = process.env.WELCOME_MESSAGE?.trim()
    return { text: override || this.buildWelcomeText(capabilities), capabilities }
  }

  /** 欢迎语正文：默认按能力清单生成（无能力时提示未配置） */
  private buildWelcomeText(capabilities: readonly WelcomeCapability[]): string {
    const lines: string[] = [
      '你好，我是本站的智能助手 👋',
      '我可以理解你的需求，直接帮你打开并操作对应的页面。',
    ]
    if (capabilities.length) {
      lines.push('', '目前我能帮你：')
      for (const cap of capabilities) {
        const label = cap.title || cap.name || cap.tag
        const hint = cap.examples?.[0]
        lines.push(`- ${label}${hint ? `（例如：${hint}）` : ''}`)
      }
      lines.push('', '直接说出你想做什么就可以了。')
    } else {
      lines.push('', '当前还没有配置可操作的页面，请联系管理员。')
    }
    return lines.join('\n')
  }

  buildAgentContext(session?: Pick<AgentSession, 'currentPage' | 'pageExposedKeys' | 'recentObservations' | 'modeDecision' | 'plan' | 'planTurn' | 'pendingQuestion'>): string {
    const manifest = this.getManifest()
    const lines = ['你是一个网页助手，需要根据用户目标选择并操作页面。', '', '可用页面：']
    for (const page of manifest.pages) {
      lines.push(`- <${page.tag}> ${page.title || page.name}（${page.path}）`)
      if (page.description) lines.push(`  功能：${page.description}`)
      if (page.keywords?.length) lines.push(`  关键词：${page.keywords.join('、')}`)
      if (page.params?.length) {
        // 入参按通道分段（manifest 的 params[].in，analyzer 从 path 与页面源码探测得出）：
        // 路径参数进 URL 路径；查询参数会被下发成 ?key=value，页面用 route.query 读取。
        const describeParam = (item: (typeof page.params)[number]) =>
          `${item.name}(${item.type})${item.description ? `：${item.description}` : ''}`
        const pathParams = page.params.filter((item) => item.in !== 'query')
        const queryParams = page.params.filter((item) => item.in === 'query')
        if (pathParams.length) lines.push(`  路径参数：${pathParams.map(describeParam).join('、')}`)
        if (queryParams.length) {
          lines.push(
            `  查询参数：${queryParams.map(describeParam).join('、')}` +
              '（放进 render 的 params，会作为 URL query 下发，页面通过 route.query 读取）',
          )
        }
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
      // 页面级规则：只在该页面生效（随 manifest 下发，跳过 disabled）
      const pageRules = (page.rules ?? []).filter((rule) => !rule.disabled)
      if (pageRules.length) {
        lines.push('  页面规则（只在该页面生效）：')
        for (const rule of pageRules) lines.push(`    - [${rule.name}] ${rule.instructions}`)
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
    lines.push('   例：call_page_method({ name: "nextPage" })；call_page_method({ name: "openCreateDialog", args: [{ name: "订单库", host: "10.0.0.9", port: 3306 }] })')
    lines.push('8. 页面方法只用来「打开 / 预填 / 翻页 / 筛选 / 导航」：保存、新增、删除等写后端的动作不在可调用方法里，必须请用户在页面上确认提交；预填后要明确告诉用户「已填好，请确认」。')
    lines.push('9. render 的 params 同时承载两种入参通道：清单里未标注的是路径参数（进 URL 路径），标注为「查询参数」的会下发成 ?key=value；两者都放进同一个 params 对象，不要改用 props 传参数，也不要自己拼 path 或 query 串。')
    lines.push('10. 任务需要多步（跨多个页面 / 多次操作 / 需要汇总对比）或信息不足时，**先给出计划**：调用 propose_plan 拆成 1~8 步。计划模式下一句话的任务不要拆（直接做）；**直接执行模式（见「本轮模式」段）下不要出计划**。')
    lines.push('11. 调用 propose_plan 后本轮立即结束、等用户确认；用户确认前不要操作页面（计划模式下会被拒绝执行）。')
    lines.push('12. 信息不足且无法从页面数据中得到时，用 ask_user 提问（2~5 个选项，一次只问一个）；不要猜测业务参数，也不要用它问"是否继续"这类客套话。')
    lines.push('13. 一轮最多推进计划的 2~3 步：做完就调用 finish_turn 交接进度（done 填已完成的步骤 id），让用户能看到进展并决定是否继续。')
    lines.push('14. 步数快用完时（系统会提前一步提醒）优先调用 finish_turn 收尾，不要开启新的页面操作；整件事做完时用 doneAll=true。')
    lines.push('15. 用户对**当前计划**提修改意见时（见「本轮是计划修改」段）必须调用 revise_plan，并回填**修订后的完整步骤序列**：未改动的步骤原样带回它的 id 与标题（否则会被当成"删掉再加一个"，已完成状态与进度就丢了），新增的步骤不要带 id，要删除的步骤不要出现在 steps 里，改到已完成的步骤时对它传 reopen:true。**不要**因为一句修改意见就换一份新计划（那会清空进度）。')

    // 项目规则：随 manifest 下发（wc.pages.json 的 rules 自动收集），优先于上面的通用规则。
    const projectRules = this.getRules().filter((rule) => !rule.disabled)
    if (projectRules.length) {
      lines.push('', '项目规则（来自本项目 manifest，优先于上面的通用规则；冲突时以项目规则为准）：')
      for (const rule of projectRules) lines.push(`- [${rule.name}] ${rule.instructions}`)
    }

    // 本轮模式与计划门禁状态（由 agent.service 的 decideMode 写入 session）
    const decision = session?.modeDecision
    if (decision) {
      const label = decision.effective === 'plan' ? '计划模式' : '直接执行模式'
      lines.push('', `[本轮模式] ${label}（请求值：${decision.requested}，判定来源：${decision.decidedBy}${decision.reason ? `，理由：${decision.reason}` : ''}）`)
      if (decision.effective === 'plan') {
        const approved = session?.plan?.approvedAt != null && session?.plan?.status !== 'superseded'
        lines.push(
          approved
            ? '  计划已由用户确认 —— 可以按计划操作页面；一轮推进 2~3 步后调用 finish_turn 交接。'
            : `  计划尚未确认 —— render / call_page_method 会被拒绝执行。请先用 propose_plan 给出计划。（${PLAN_HINT}）`,
        )
      } else {
        // act 模式下不要出计划卡：用户显式选了"直接执行"（或启发式判定为单页直做）——
        // 这时再弹一张"要不要开始"的卡是把选择权又塞回给用户。需要多步就直接做、用 finish_turn 交接。
        lines.push('  用户要的是直接执行 —— **不要调用 propose_plan**；直接操作页面，一轮推进不完就用 finish_turn 交接进度。')
      }
    }

    // 本轮的"修改计划"意图（`chat.send.revisePlanId`）：必须在当前计划段之前说清楚
    // 「用户是在改这一份，不是在要一份新的」，否则模型很容易顺手 propose_plan 把进度清掉。
    const planTurn = session?.planTurn
    if (planTurn) {
      lines.push('', `[本轮是计划修改] 用户对当前计划（planId=${planTurn.planId}）提出了修改意见：`)
      lines.push(`  ${planTurn.text}`)
      lines.push(
        '  必须调用 revise_plan 把修改意见落到计划上（不能用 propose_plan 换新计划）：' +
          '回填**修改后的完整步骤序列**，未改动的步骤原样带回它的 id 与标题，' +
          '新增的步骤不要带 id，要删除的步骤不要出现在 steps 里，改到已完成的步骤时对它传 reopen:true。',
      )
    }

    // 当前计划与进度（计划式分轮推进的"锚点"：没有它，下一轮只能靠模型自己回忆做到哪了）
    const plan = session?.plan
    if (plan && plan.status !== 'superseded') {
      const done = plan.steps.filter((step) => step.status === 'done')
      const version = plan.revision && plan.revision > 1 ? `；已修订 ${plan.revision - 1} 次（当前第 ${plan.revision} 版）` : ''
      lines.push('', `[当前计划 ${plan.id}] ${plan.summary}（状态：${plan.status}${version}）`)
      for (const step of plan.steps) {
        lines.push(`  ${step.status === 'done' ? '[x]' : '[ ]'} ${step.id} ${step.title}${step.detail ? `（${step.detail}）` : ''}`)
      }
      lines.push(
        done.length === plan.steps.length
          ? '  计划已全部完成。'
          : `  已完成 ${done.length}/${plan.steps.length}；finish_turn 的 done 请填这些步骤 id：${plan.steps.filter((s) => s.status === 'pending').map((s) => s.id).join('、')}`,
      )
    }

    // 上一个提问与用户的回答（提问是"回合边界"：回答在下一条用户消息里，必须显式对上）
    const question = session?.pendingQuestion
    if (question) {
      lines.push('', '[最近的提问]')
      lines.push(`  你问了：${question.question}（选项：${question.options.join(' / ')}）`)
      lines.push(
        question.answeredAt
          ? `  用户已回答：${question.answer ?? ''}`
          : '  用户还没回答 —— 等他回答，不要重复提问，也不要猜答案。',
      )
    }

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
        if (obs.type === 'page.data') {
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
    const url = manifestUrl()
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
    let mtimeMs: number
    try {
      mtimeMs = statSync(filePath).mtimeMs
    } catch {
      // 把 ENOENT 变成可操作的提示：相对路径按**当前工作目录**解析，而 `pnpm --filter agent-server`
      // 启动时 cwd 是 packages/agent-server（写仓库根的路径会差一层 demo-app）
      throw new Error(
        `MANIFEST_PATH 指向的文件不存在：${filePath}（cwd=${process.cwd()}）。` +
          '相对路径按当前工作目录解析 —— 用 `pnpm dev:agent`（= --filter agent-server）启动时 cwd 是 ' +
          'packages/agent-server，仓库根的 manifest 应写成 ../demo-app/public/wc/manifest.json，' +
          '或直接给绝对路径；只有装不进去的包才会用 MANIFEST_URL 远程拉取。',
      )
    }
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
    const configured = process.env.MANIFEST_PATH
    if (configured) {
      // 相对路径按**当前工作目录**解析（与 node 习惯一致）；写错时由 reloadFileIfChanged 给出可读提示
      return path.resolve(process.cwd(), configured)
    }
    return path.resolve(moduleDir, '../../../demo-app/public/wc/manifest.json')
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
      if (typeof page.name !== 'string') {
        throw new Error(`manifest page ${page.tag} requires name`)
      }
      // ⚠️ bundle **不是**必填：只有 WC 批次（用法 A）的页面才经产物编译。
      //    宿主直连批次（用法 B / host）的页面是宿主自己的路由组件，manifest 里没有 bundle
      //    （protocol 的 pages[].bundle 本就是可选）。这里只校验「给了就必须是字符串」。
      //    历史坑：把 bundle 当必填会让 host manifest 在本地文件模式下启动崩、在远端模式下被
      //    tryLoadRemote 吞掉变成空目录（agent 静默失明），见 test/manifest.host.test.ts。
      if (page.bundle !== undefined && typeof page.bundle !== 'string') {
        throw new Error(`manifest page ${page.tag}.bundle must be a string when present`)
      }
    }
    return candidate as RuntimeManifest
  }
}
