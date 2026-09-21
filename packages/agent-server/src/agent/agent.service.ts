import { Inject, Injectable, Logger } from '@nestjs/common'
import crypto from 'node:crypto'
import { Agent, createTool } from '@cline/sdk'

interface AgentEventEnvelope {
  type: string
  iteration?: number
  text?: string
  /** tool-started / tool-finished 携带的调用信息（input 是工具实参） */
  toolCall?: { toolName: string; toolCallId?: string; input?: unknown }
  /** tool-finished 携带的结算消息（parts 里有 tool-result，isError 表示成败） */
  message?: unknown
  error?: unknown
  /** SDK 对 provider 错误的分类（run-failed 事件携带），便于定位失败原因 */
  errorClass?: string
}
import type {
  AgentStepMessage,
  AskUserToolArgs,
  CallPageMethodToolArgs,
  FinishTurnToolArgs,
  ProposePlanToolArgs,
  RevisePlanToolArgs,
  RenderToolArgs,
  WaitForObservationToolArgs,
} from '@webassistant/protocol/websocket'
import type { AgentMode, AgentRunStatus, AgentSession, ModeDecision } from '@webassistant/protocol'
import { DEFAULT_MAX_TURN_MESSAGES, projectTurnMessages } from './turnProjection.js'
import { resolveDefaultMode, resolveMode, type ModePageHint } from './mode.js'
import {
  applyPlanProgress,
  buildPlan,
  buildQuestion,
  mergePlanRevision,
  normalizeAskArgs,
  normalizeFinishArgs,
  normalizePlanArgs,
  normalizeReviseArgs,
  planProgress,
  projectTurnEnd,
  type TurnEndProjection,
} from './turnEnd.js'
import { ManifestService } from '../manifest/manifest.service.js'
import { SessionService } from '../session/session.service.js'
import { RpcService } from '../rpc/rpc.service.js'
import { truncate, errorText } from '../logging.js'
import { projectTraceEvent } from './traceEvents.js'

const MAX_ITERATIONS = Number(process.env.MAX_AGENT_STEPS || 12)
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_CALL_TIMEOUT_MS || 8_000)
const OBSERVATION_TIMEOUT_MS = Number(process.env.OBSERVATION_WAIT_TIMEOUT_MS || 10_000)

/**
 * plan 门禁：`hard`（默认）时，plan 模式下**未确认计划**的 `render` / `call_page_method`
 * 会被 `hooks.beforeTool` 直接拦掉（工具不执行，模型收到 isError 的 tool-result）；
 * `off` 时降级为软提醒（`appendContext` 注入提示但仍放行）。
 */
const PLAN_GATE = process.env.PLAN_GATE === 'off' ? 'off' : 'hard'

/** 未配置 `chat.send.mode` 时的默认模式（`auto` / `act` / `plan`，非法值回落 `auto`） */
const MODE_DEFAULT: AgentMode = resolveDefaultMode(process.env.MODE_DEFAULT)

/**
 * 步数软着陆的提醒文案。
 * 模型**无法感知**自己还剩几步（SDK 不告诉它），只能由服务端在倒数一步时明确告知，
 * 否则"复杂任务跑到一半被上限打断"就是必然的。
 */
const TURN_BUDGET_REMINDER =
  `[SYSTEM] 本轮步数即将用尽（上限 ${MAX_ITERATIONS} 步）。` +
  '现在必须收尾：立刻调用 finish_turn 说明已完成什么、还剩什么（若整个任务已完成则 doneAll=true）。' +
  '不要开启新的页面操作，也不要调用 wait_for_observation。'

/** 单轮 run 被步数上限打断时的用户可见文案（**不是**错误） */
const BUDGET_PAUSED_TEXT =
  '本轮步数已用尽，任务已暂停（进度都已保存）。回复「继续」我接着做；' +
  '如果希望一次多做几步，可以调大服务端的 MAX_AGENT_STEPS。'

/** plan 门禁的拦截原因 —— 必须写清"怎么解锁"，否则模型会在拦截和重试之间空转 */
const PLAN_GATE_REASON =
  '计划模式下，尚未确认计划时不能操作页面。' +
  '请先调用 propose_plan 给出计划（本轮会以计划卡收尾并等用户确认），或请用户在计划卡上点「开始执行」。'

/**
 * 修订轮里 `propose_plan` 的拦截原因。
 *
 * 为什么这条也要硬拦（而不只是 prompt 里叮嘱）：用户点「修改计划」的意思是"改这一份"，
 * 一旦模型顺手 `propose_plan`，就会生成新 planId、旧计划被标 `superseded`、
 * 已完成步骤全部回到 `pending` —— "改计划退化成换计划"正是本变更要消灭的病症。
 */
const REVISE_PLAN_REASON =
  '本轮是"修改计划"（用户对当前计划提出了修改意见），不能用 propose_plan 换一份新计划。' +
  '请调用 revise_plan 回填**修改后的完整步骤序列**：未改动的步骤原样带回它的 id 与标题，' +
  '新增的步骤不要带 id，要删除的步骤不要出现在 steps 里。'


/** 单次请求投影的消息上限（长驻 transcript 可能累积几十轮，避免 token 无界增长） */
const MAX_TURN_MESSAGES = Number(process.env.MAX_TURN_MESSAGES || DEFAULT_MAX_TURN_MESSAGES)

/**
 * config 里的 systemPrompt 只是兜底：真正下发的是 `prepareTurn` 每轮投影出来的
 * `buildAgentContext(session)`（含 manifest / 规则 / 当前页可用方法 / 最近观察）。
 */
const STATIC_SYSTEM_PROMPT =
  '你是一个网页助手：用工具操作被服务的网页（打开页面 / 等待数据 / 调用页面方法），并简洁回答用户。' +
  '每一轮的可用页面、规则、当前页可用方法与最近观察由宿主在请求前注入，请以那一份为准。'

/** Agent 构造参数与 `prepareTurn` / `hooks` 上下文（SDK 未导出后者，从构造签名里取，避免依赖内部路径）。 */
type AgentRuntimeConfig = ConstructorParameters<typeof Agent>[0]
type PrepareTurnContext = Parameters<NonNullable<AgentRuntimeConfig['prepareTurn']>>[0]
type AgentHooksConfig = NonNullable<AgentRuntimeConfig['hooks']>
type BeforeModelContext = Parameters<NonNullable<AgentHooksConfig['beforeModel']>>[0]
type BeforeToolContext = Parameters<NonNullable<AgentHooksConfig['beforeTool']>>[0]

/** 会话的长驻 agent runtime（会话 = 连接：连接期间复用，断开时 dispose）。 */
interface SessionAgentEntry {
  agent: Agent
  unsubscribe: () => void
  /** 是否有 run 在执行（同会话串行；SDK 自身也会拒绝并发 run） */
  running: boolean
  /** 当前 run 已流式产出的助手文本（run 结束后用于兜底补发 outputText） */
  streamedText: string
  /** 当前 run 的错误分类（run-failed 事件携带），仅用于日志 */
  errorClass?: string
  /**
   * 当前 run 里每个工具调用的开始时间（toolCallId → ms）。
   * SDK 的 `tool-finished` 事件**不带** durationMs，耗时只能自己配对算 ——
   * 没有它过程区就只能显示一堆没有时间感的步骤。
   */
  toolStartedAt: Map<string, number>
  /**
   * 本轮由收尾工具（`propose_plan` / `ask_user` / `finish_turn`）结束时的投影结果。
   * 在工具 execute 里写入、在 run 收尾时统一冲刷 —— 这样「卡片 → chat.done」的顺序稳定，
   * 且"兜底文本是否抑制"只在一处判断（见 turnEnd.ts 顶部注释）。
   */
  turnEnd?: TurnEndProjection
}

/**
 * 本轮的附加指令（都来自 `chat.send` 的可选字段）。
 * 处理顺序有讲究：**确认计划必须在 run 之前** —— 否则本轮第一次 `render`
 * 会被 plan 门禁拦下来（`session.plan.approvedAt` 还是空的）。
 */
export interface RunTurnOptions {
  /** 客户端显式请求的模式（`auto` / `act` / `plan`）；缺省沿用会话模式 */
  mode?: AgentMode
  /** 用户确认的计划 id（计划卡「开始执行」） */
  planId?: string
  /** 用户对当前计划的修改意见（计划卡「修改计划」）：值为当前计划 id，`text` 即意见本身 */
  revisePlanId?: string
  /** 用户回答的问题 id（问题卡选项；直接打字时为空） */
  questionId?: string
}

/**
 * 是否"单轮步数用尽"。
 * SDK 在打满 `maxIterations` 后抛 `Agent runtime exceeded maxIterations (N)`，
 * 被 catch 成 `status: 'failed'` —— 但对用户来说这不是失败，只是**被单轮预算截断**。
 * 用文案识别（SDK 未提供结构化标记），识别不到也无妨（退回原来的 chat.error）。
 */
export function isBudgetExhausted(result: { status: string; error?: Error }): boolean {
  if (result.status !== 'failed' || !result.error) return false
  return /exceeded maxIterations/i.test(result.error.message)
}

/**
 * 本轮 run 的结束状态。
 * 收尾工具结束的一轮**不是** `completed` 那么简单：
 * - `propose_plan` / `revise_plan` → `waiting-plan`（等用户确认计划）
 * - `ask_user` → `waiting-user`（等用户回答）
 * - `finish_turn` / 模型自然结束 → `completed`
 * `waiting-*` 表示"上一轮停在等用户决策"，不是"run 还活着"（run 已经结束了）。
 */
export function resolveRunStatus(
  result: { status: string },
  turnEnd: TurnEndProjection | undefined,
  limitExhausted: boolean,
): AgentRunStatus {
  if (result.status === 'aborted') return 'cancelled'
  if (result.status === 'failed') return limitExhausted ? 'completed' : 'failed'
  if (turnEnd?.endedBy === 'propose_plan' || turnEnd?.endedBy === 'revise_plan') return 'waiting-plan'
  if (turnEnd?.endedBy === 'ask_user') return 'waiting-user'
  return 'completed'
}

/**
 * `hooks.beforeTool` 的门禁判定（纯函数，导出以便单测）。
 *
 * 两条拦截，理由与顺序都有讲究：
 * 1. **修订轮不许换计划**（与 `PLAN_GATE` 无关，`off` 也生效）：用户点「修改计划」的意思是"改这一份"，
 *    一旦模型顺手 `propose_plan`，就会生成新 planId、旧计划被标 `superseded`、已完成步骤全部回到
 *    `pending` —— 那正是本变更要消灭的病症，所以它必须是**服务端保证**，不能只靠 prompt。
 * 2. **计划模式下未确认计划不许操作页面**（`PLAN_GATE=hard`，默认开）。
 *
 * 拦截发生在同一轮内（SDK 把 skip 变成 isError 的 tool-result），不额外消耗模型调用。
 */
export function beforeToolGate(input: {
  toolName: string
  /** 本轮是不是"修改计划"（`session.planTurn` 存在） */
  revisingPlan: boolean
  /** 本轮生效模式（`act` / `plan`） */
  effectiveMode?: 'act' | 'plan'
  /** 当前计划是否已被用户确认（`session.plan.approvedAt` 是否非空） */
  planApproved: boolean
  planGate: 'hard' | 'off'
}): { skip: true; reason: string } | undefined {
  if (input.toolName === 'propose_plan' && input.revisingPlan) {
    return { skip: true, reason: REVISE_PLAN_REASON }
  }
  if (input.planGate !== 'hard') return undefined
  if (input.effectiveMode !== 'plan') return undefined
  if (input.planApproved) return undefined
  if (input.toolName !== 'render' && input.toolName !== 'call_page_method') return undefined
  return { skip: true, reason: PLAN_GATE_REASON }
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name)
  private readonly sessionAgents = new Map<string, SessionAgentEntry>()

  constructor(
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(RpcService) private readonly rpc: RpcService,
  ) {}

  /**
   * 取（或懒建）本会话的长驻 agent runtime。
   *
   * 会话 = 连接：一个连接一个实例，实例内的 `state.messages` 即本连接的对话上下文（多轮由此承载），
   * 连接断开时由 `disposeSession()` 释放。每轮的动态上下文（manifest / 当前页方法 / 最近观察）
   * 与消息裁剪由 `prepareTurn` 投影注入 —— 只影响当次请求，不写进 transcript。
   */
  private getOrCreateAgent(session: AgentSession): SessionAgentEntry {
    const sessionId = session.id
    const existing = this.sessionAgents.get(sessionId)
    if (existing) return existing

    // 先声明、后赋值：收尾工具的 execute 会写 `entry.turnEnd`（闭包捕获这个变量）。
    let entry: SessionAgentEntry

    const renderTool = createTool<RenderToolArgs, unknown>({
      name: 'render',
      description: '打开页面。操作会立即确认，不代表页面数据已经返回。',
      inputSchema: {
        type: 'object',
        properties: {
          // 长驻实例会跨多轮复用，而 manifest 可热重载 → 不锁 enum（否则新增页面后旧枚举会把参数拒掉）。
          // 「只能用清单里的 tag」这条约束改由 prompt 承担（buildAgentContext 的「可用页面」段）。
          tag: {
            type: 'string',
            description: '目标页面 tag，必须取自系统提示中「可用页面」清单里的 <tag>',
          },
          params: { type: 'object' },
          props: { type: 'object' },
        },
        required: ['tag'],
      },
      execute: async (input: RenderToolArgs) => {
        return this.rpc.call(sessionId, 'render', input, TOOL_TIMEOUT_MS)
      },
    })

    const waitTool = createTool<WaitForObservationToolArgs, unknown>({
      name: 'wait_for_observation',
      description:
        '等待页面显式上报的数据（page.data）或页面事件（page.emit）中出现与目标相关的内容。' +
        '注意：runtime 不自动采集网络请求，宿主/页面只会上报它愿意公开的数据 —— ' +
        '如果什么都没上报，这里会超时；不要猜测未观察到的业务数据。',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          match: {
            type: 'object',
            description:
              '匹配条件：page（页面 tag）/ source（上报来源标识）/ event（页面事件名）/ ' +
              'contains（在数据里查找的字符串）。',
          },
          timeoutMs: { type: 'number' },
        },
      },
      execute: async (input: WaitForObservationToolArgs) => {
        return this.sessions.waitForObservation(
          sessionId,
          { ...(input.match || {}), ...(input.page ? { page: input.page } : {}) },
          Math.min(input.timeoutMs || OBSERVATION_TIMEOUT_MS, OBSERVATION_TIMEOUT_MS),
        )
      },
    })

    const callPageMethodTool = createTool<CallPageMethodToolArgs, unknown>({
      name: 'call_page_method',
      description:
        '调用当前页面（或指定页面）通过 defineExpose 暴露的方法。' +
        'name 必须是 manifest.pages[].exposes[].name 之一；page 不传默认当前页。' +
        'args 是「按方法签名顺序」排列的实参数组：签名里出现的参数必须在这里传齐，' +
        '否则会以 undefined 调用而失败（例如 save(data) 需要给 args:[{...}]）。' +
        '返回值经 ws 回流到 tool.result，可被下一次观察 / 推理引用。',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: '目标页面 tag；不传表示当前页' },
          name: { type: 'string', description: '方法名，必须命中当前页 exposes 列表' },
          args: {
            type: 'array',
            description:
              '方法实参，按签名顺序排列；方法需要参数时必须提供。' +
              '例：调用 save(data) 时写 [{ "name": "新数据源", "host": "127.0.0.1" }]',
            items: {},
          },
          timeoutMs: { type: 'number' },
        },
        required: ['name'],
      },
      execute: async (input: CallPageMethodToolArgs) => {
        return this.rpc.call(sessionId, 'call_page_method', input, TOOL_TIMEOUT_MS)
      },
    })

    // ───────── 收尾工具（lifecycle.completesRun）：把"一轮怎么结束"从"失败"变回"正常状态" ─────────
    //
    // 为什么它们不走 rpc.call：这几个动作**不需要浏览器执行任何东西** —— 计划卡 / 问题卡是
    // 服务端主动推的结构化消息（chat.plan / chat.ask），不是"让前端做一件事"。走 RPC 反而要
    // 处理 pending 配对与超时。它们只做两件事：更新 session、记下本轮怎么结束（entry.turnEnd）。

    const proposePlanTool = createTool<ProposePlanToolArgs, unknown>({
      name: 'propose_plan',
      description:
        '为一个需要多步完成的任务给出执行计划，然后结束本轮、等用户确认。' +
        '适合：跨多个页面 / 需要多次操作 / 需要汇总对比的任务。' +
        '调用后本轮立即结束并弹出计划卡；用户确认前不要操作页面（计划模式下会被拦）。' +
        '不要把一句话就能做完的任务拆成计划。',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '一句话说明这个计划要达成什么' },
          steps: {
            type: 'array',
            description: '有序步骤（1~8 条），每步一句话；不要写实现细节',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '这一步要做什么' },
                detail: { type: 'string', description: '可选补充（页面 / 参数等）' },
              },
              required: ['title'],
            },
          },
        },
        required: ['summary', 'steps'],
      },
      lifecycle: { completesRun: true },
      retryable: false,
      maxRetries: 0,
      execute: async (input: ProposePlanToolArgs) => {
        // 非法入参抛错 → SDK 把工具结果标成 isError，模型看到原因后可自行修正（不会结束本轮）
        const normalized = normalizePlanArgs(input)
        const plan = buildPlan(normalized, { id: crypto.randomUUID(), now: Date.now() })
        this.sessions.recordPlan(session, plan)
        entry.turnEnd = projectTurnEnd({ tool: 'propose_plan', plan })
        this.logger.log(
          `propose_plan session=${sessionId} planId=${plan.id} steps=${plan.steps.length} summary="${truncate(plan.summary)}"`,
        )
        return { status: 'plan-proposed', planId: plan.id, steps: plan.steps.map((step) => step.title) }
      },
    })

    const revisePlanTool = createTool<RevisePlanToolArgs, unknown>({
      name: 'revise_plan',
      description:
        '在**当前计划**上按用户的修改意见做增量修订（不是换一份新计划），然后结束本轮、等用户确认。' +
        '用户对计划提意见时**只能用它**（不要用 propose_plan）。' +
        'steps 必须是**修订后的完整步骤序列**：未改动的步骤原样带回它的 id 与标题（这样它的完成状态与进度不会丢），' +
        '新增的步骤不要带 id，要删除的步骤不要出现在 steps 里；改到已完成的步骤时对它传 reopen: true。' +
        '顺序以 steps 为准（可以借此调整步骤顺序）。',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '一句话说明这次改了什么（给用户看）' },
          summary: { type: 'string', description: '修订后的目标；不改目标就省略' },
          steps: {
            type: 'array',
            description: '修订后的完整步骤（1~8 条）；原地改的步骤要带上它原来的 id',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '要原地修改的既有步骤 id（如 step-2）；新增步骤不要带' },
                title: { type: 'string', description: '这一步要做什么（改后的表述）' },
                detail: { type: 'string', description: '可选补充（页面 / 参数等）' },
                reopen: {
                  type: 'boolean',
                  description: '该步骤原本已完成，但这次改动需要重做 → 置回未完成',
                },
              },
              required: ['title'],
            },
          },
        },
        required: ['steps'],
      },
      lifecycle: { completesRun: true },
      retryable: false,
      maxRetries: 0,
      execute: async (input: RevisePlanToolArgs) => {
        // planId 取本轮的修订意图（`chat.send.revisePlanId`）；没有意图就该走 propose_plan
        const planId = session.planTurn?.planId
        if (!planId) {
          throw new Error('本轮不是"修改计划"（用户没有提出修改意见）；要换计划请调用 propose_plan')
        }
        const current = session.plan
        if (!current || current.id !== planId) {
          throw new Error('当前计划已经变化（可能已被重新生成）；请先看最新的计划卡，再按用户要求处理')
        }
        // 非法入参（未知 step id / 空 steps / 合并后超限）抛错 → SDK 标 isError，模型可自行修正
        const normalized = normalizeReviseArgs(input, current)
        const revision = mergePlanRevision(current, normalized, Date.now())
        const outcome = this.sessions.revisePlan(session, planId, revision.plan)
        if (outcome !== 'revised') {
          throw new Error('当前计划已经变化（可能已被重新生成）；请先看最新的计划卡')
        }
        const revised = session.plan ?? revision.plan
        entry.turnEnd = projectTurnEnd({
          tool: 'revise_plan',
          plan: revised,
          changes: revision.changes,
          ...(normalized.note ? { note: normalized.note } : {}),
        })
        const { added, changed, removed } = revision.changes
        this.logger.log(
          `revise_plan session=${sessionId} planId=${revised.id} revision=${revised.revision ?? 1} ` +
            `added=${added} changed=${changed.length} removed=${removed.length}`,
        )
        return {
          status: 'plan-revised',
          planId: revised.id,
          revision: revised.revision ?? 1,
          steps: revised.steps.map((step) => ({ id: step.id, title: step.title, status: step.status })),
        }
      },
    })

    const askUserTool = createTool<AskUserToolArgs, unknown>({
      name: 'ask_user',
      description:
        '信息不足、且无法从页面数据里得到时，向用户提一个问题（一次只问一个）。' +
        '2~5 个可选项，用户也可以自由输入。调用后本轮立即结束并弹出问题卡，用户回答后你会在下一轮收到答复。' +
        '不要用它确认"是否继续"这类客套话；缺参数、目标不明确、多个同名候选时才是它的用武之地。',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的那一个问题' },
          options: {
            type: 'array',
            description: '2~5 个可选项（尽量互斥、覆盖常见答案）',
            items: { type: 'string' },
          },
        },
        required: ['question', 'options'],
      },
      lifecycle: { completesRun: true },
      retryable: false,
      maxRetries: 0,
      execute: async (input: AskUserToolArgs) => {
        const normalized = normalizeAskArgs(input)
        const question = buildQuestion(normalized, { id: crypto.randomUUID(), now: Date.now() })
        this.sessions.recordQuestion(session, question)
        entry.turnEnd = projectTurnEnd({ tool: 'ask_user', question })
        this.logger.log(
          `ask_user session=${sessionId} questionId=${question.id} question="${truncate(question.question)}" options=${question.options.length}`,
        )
        return { status: 'waiting-answer', questionId: question.id, options: question.options }
      },
    })

    const finishTurnTool = createTool<FinishTurnToolArgs, unknown>({
      name: 'finish_turn',
      description:
        '结束本轮并交接进度：这一轮做了什么、计划里还剩什么。' +
        '**任何一轮都可以用它优雅收尾**（尤其是步数快用完时）；整个任务完成时用 doneAll=true。' +
        '调用后本轮立即结束并把进度展示给用户，用户回复「继续」即可接着做。',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '这一轮做了什么 / 现在什么状态（给用户看的一句话）' },
          done: {
            type: 'array',
            description: '已完成的计划步骤 id（如 step-1）；没有计划时可省略',
            items: { type: 'string' },
          },
          remaining: {
            type: 'array',
            description: '剩余的计划步骤 id；仅用于说明，进度以 done 为准',
            items: { type: 'string' },
          },
          doneAll: { type: 'boolean', description: '整个任务是否已完成' },
        },
        required: ['summary'],
      },
      lifecycle: { completesRun: true },
      retryable: false,
      maxRetries: 0,
      execute: async (input: FinishTurnToolArgs) => {
        const finish = normalizeFinishArgs(input)
        const now = Date.now()
        const updated = applyPlanProgress(session.plan, finish, now)
        this.sessions.updatePlan(session, updated)
        const progress = planProgress(updated)
        entry.turnEnd = projectTurnEnd({ tool: 'finish_turn', finish, progress })
        this.logger.log(
          `finish_turn session=${sessionId} doneAll=${finish.doneAll} done=${finish.done.length} progress=${progress.doneCount}/${progress.total} summary="${truncate(finish.summary)}"`,
        )
        return {
          status: finish.doneAll ? 'all-done' : 'turn-finished',
          progress,
          remaining: finish.remaining,
        }
      },
    })

    entry = {
      agent: new Agent({
        providerId: 'openai-compatible',
        modelId: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
        // 只放稳定内容；易变上下文（manifest / 当前页 / 观察）由 prepareTurn 每轮注入
        systemPrompt: STATIC_SYSTEM_PROMPT,
        tools: [
          renderTool,
          waitTool,
          callPageMethodTool,
          proposePlanTool,
          revisePlanTool,
          askUserTool,
          finishTurnTool,
        ],
        maxIterations: MAX_ITERATIONS,
        sessionId,
        // ───────── 两个 hook：一个做步数软着陆，一个做 plan 硬门禁 ─────────
        hooks: {
          /**
           * 步数软着陆：模型不知道自己还剩几步，只能在**倒数一步**由服务端告诉它。
           * `messages` 只替换当次 provider 请求（不写 transcript）—— 正是我们要的"投影"。
           *
           * 为什么不用 `{ stop: true }`：SDK 的 `applyStopControl` 会抛 `AgentRuntimeAbortError`，
           * 一轮会被记成 `aborted`（服务端→`cancelled`），用户看到的是"被取消"而不是"该收尾了"。
           */
          beforeModel: (context: BeforeModelContext) => {
            if (MAX_ITERATIONS <= 1) return undefined
            if (context.snapshot.iteration < MAX_ITERATIONS - 1) return undefined
            const reminder = {
              id: `budget-reminder-${context.snapshot.iteration}`,
              role: 'user' as const,
              content: [{ type: 'text' as const, text: TURN_BUDGET_REMINDER }],
              createdAt: Date.now(),
            }
            this.logger.debug(
              `turn budget reminder session=${sessionId} iteration=${context.snapshot.iteration}/${MAX_ITERATIONS}`,
            )
            return { messages: [...context.request.messages, reminder] }
          },
          /**
           * plan 硬门禁 + 修订轮门禁：判定逻辑全在 `beforeToolGate`（纯函数，可单测）。
           * SDK 把 `skip` 变成 isError 的 tool-result 回给模型，模型据此转向 propose_plan / revise_plan。
           */
          beforeTool: (context: BeforeToolContext) => {
            const decision = beforeToolGate({
              toolName: context.tool.name,
              revisingPlan: session.planTurn != null,
              effectiveMode: session.modeDecision?.effective,
              planApproved: session.plan?.approvedAt != null,
              planGate: PLAN_GATE,
            })
            if (!decision) return undefined
            this.logger.log(
              `tool gate blocked session=${sessionId} tool=${context.tool.name} ` +
                `revising=${session.planTurn != null}（${decision.reason.slice(0, 24)}…）`,
            )
            return decision
          },
        },
        prepareTurn: (context: PrepareTurnContext) => {
          // 每轮取「此刻」的页面上下文 —— manifest 热重载 / 切页 / 新观察下一轮即生效
          const projected = projectTurnMessages(context.messages, MAX_TURN_MESSAGES)
          return {
            systemPrompt: this.manifests.buildAgentContext(session),
            // 有界裁剪：只影响本次请求，不改 runtime 的 canonical transcript。
            // 仅在**真的裁掉了**才回传 messages —— SDK 的 overflow 恢复路径要求
            // 「返回的 messages 必须严格短于原消息」（prepareTurnForModelRequest 里断言），
            // 原样回传会让上下文溢出恢复退化成硬报错。
            ...(projected.length < context.messages.length ? { messages: projected } : {}),
          }
        },
      }),
      unsubscribe: () => {},
      running: false,
      streamedText: '',
      toolStartedAt: new Map(),
    }
    // 订阅一次、活到会话结束：事件 → 消息 的映射全在 traceEvents.ts（纯函数、可单测），
    // 这里只负责把投影出来的消息推给本连接。
    entry.unsubscribe = entry.agent.subscribe((rawEvent: unknown) => {
      const event = rawEvent as AgentEventEnvelope
      if (event.type === 'run-failed') entry.errorClass = event.errorClass

      const { messages, streamText } = projectTraceEvent(event, entry.toolStartedAt)
      if (streamText && event.text) entry.streamedText += event.text
      for (const message of messages) {
        // 过程步骤留一条 debug 轨迹（排查"agent 到底做了什么"时不必开 tcpdump）
        if (message.t === 'agent.step') {
          this.logger.debug(
            `agent step ${message.phase ?? 'start'} session=${sessionId} tool=${message.tool} target=${message.target ?? '-'}${message.error ? ` error=${message.error}` : ''}`,
          )
        }
        this.rpc.notify(sessionId, message)
      }
    })
    this.sessionAgents.set(sessionId, entry)
    this.logger.debug(`agent created session=${sessionId} (sessions=${this.sessionAgents.size})`)
    return entry
  }

  /**
   * 取走本轮的收尾投影并清空。
   *
   * 为什么不直接读 `entry.turnEnd`：`entry` 是用**对象字面量**赋值的，
   * 其字面量类型不含 `turnEnd` → TS 把 `entry.turnEnd` 收窄成 `undefined`
   * （读出来永远是 undefined，`waiting-plan/waiting-user` 会静默失效）。
   * 参数类型是接口，不会收窄，所以这里读得到真实值。
   */
  private takeTurnEnd(entry: SessionAgentEntry): TurnEndProjection | undefined {
    const turnEnd = entry.turnEnd
    entry.turnEnd = undefined
    return turnEnd
  }

  /** 从 manifest 派生模式判定所需的页面线索（标签 / 关键词 / 必填路径参数个数） */
  private modePageHints(): ModePageHint[] {
    return this.manifests.getPages().map((page) => ({
      tag: page.tag,
      ...(page.title ? { title: page.title } : {}),
      ...(page.keywords ? { keywords: page.keywords } : {}),
      ...(page.exampleQueries ? { exampleQueries: page.exampleQueries } : {}),
      // 必填路径参数：有它就意味着"这个页面还需要一个用户没给的值" → 不判"单页直做"
      requiredParamCount: (page.params ?? []).filter((param) => param.in !== 'query').length,
    }))
  }

  /**
   * 判定本轮模式并下发给客户端。
   * 判定顺序见 `mode.ts`：显式 > 启发式 > 模型自判（`auto` 判不出来时取计划倾向，
   * 由模型在第一轮自选工具 —— 提示由 `buildAgentContext` 注入）。
   */
  private decideMode(session: AgentSession, text: string, requested?: AgentMode): ModeDecision {
    const decision = resolveMode(
      {
        requested,
        sessionMode: session.mode,
        text,
        pages: this.modePageHints(),
      },
      MODE_DEFAULT,
    )
    this.sessions.setMode(session, decision.requested)
    this.sessions.setModeDecision(session, decision)
    this.rpc.notify(session.id, {
      t: 'chat.mode',
      requested: decision.requested,
      effective: decision.effective,
      decidedBy: decision.decidedBy,
      ...(decision.reason ? { reason: decision.reason } : {}),
    })
    this.logger.log(
      `mode session=${session.id} requested=${decision.requested} effective=${decision.effective} decidedBy=${decision.decidedBy} reason=${decision.reason ?? '-'}`,
    )
    return decision
  }

  async run(sessionId: string, text: string, options: RunTurnOptions = {}): Promise<void> {
    const session = this.sessions.find(sessionId)
    if (!session) throw new Error('session not found')
    const entry = this.getOrCreateAgent(session)
    if (entry.running) throw new Error('agent runtime is already running')
    entry.running = true
    entry.streamedText = ''
    entry.errorClass = undefined
    entry.turnEnd = undefined
    // 上一轮若有工具没收到 tool-finished（abort / 超时），残留的配对会算出离谱耗时 —— 每轮清空
    entry.toolStartedAt.clear()
    // "修改计划"的意图只在**本轮**有效：先清除上一轮的残留，再按本轮 `chat.send` 写入。
    // 必须在任何模型调用之前落好 —— prompt（buildAgentContext）与 hooks.beforeTool 都要读它。
    this.sessions.setPlanTurn(session, undefined)
    if (options.revisePlanId) {
      const planId = options.revisePlanId
      const current = session.plan
      if (current && current.id === planId) {
        this.sessions.setPlanTurn(session, { kind: 'revise', planId, text, at: Date.now() })
        this.logger.log(`plan revise turn session=${sessionId} planId=${planId} text="${truncate(text)}"`)
      } else {
        // 过期卡片（计划已被重新生成）：不把意见合并进一份陌生计划，提示用户重新提交。
        // 本轮仍照常跑，只是不带修订意图 —— 否则客户端会卡在 loading（没有 chat.done 可等）。
        this.logger.warn(`plan revise stale session=${sessionId} revisePlanId=${planId}（当前计划已更新）`)
        this.rpc.notify(sessionId, {
          t: 'chat.text',
          delta: '计划已经更新过了，请在上面的计划卡上重新点「修改计划」。',
          channel: 'text',
        })
      }
    }
    // 模式判定必须早于任何模型调用（hooks 与 prompt 都要读它），也早于客户端看到的第一条消息
    this.decideMode(session, text, options.mode)
    session.activeRun = {
      id: crypto.randomUUID(),
      status: 'running',
      goal: text,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      stepCount: 0,
      deadline: Date.now() + Number(process.env.AGENT_RUN_TIMEOUT_MS || 60_000),
    }
    this.logger.log(
      `agent run start session=${sessionId} runId=${session.activeRun.id} mode=${session.modeDecision?.effective ?? '-'} goal="${truncate(text)}"`,
    )

    try {
      const result = await entry.agent.run(text)
      const elapsedMs = Date.now() - session.activeRun.startedAt
      session.activeRun.stepCount = result.iterations
      session.activeRun.updatedAt = Date.now()
      // 注意：必须通过方法取出（见 takeTurnEnd 注释）—— 直接读 `entry.turnEnd` 会被
      // 对象字面量赋值的类型收窄判成 `undefined`，`waiting-plan/waiting-user` 会静默失效。
      const turnEnd = this.takeTurnEnd(entry)
      const limitExhausted = isBudgetExhausted(result)
      session.activeRun.status = resolveRunStatus(result, turnEnd, limitExhausted)

      if (result.error || result.status === 'failed') {
        if (limitExhausted) {
          // 「步数用尽」不是失败：降级为"已暂停"，否则用户看到的是一条红色错误，
          // 而任务其实只是被单轮预算截断（进度都在 session 里，回复「继续」就能接着做）。
          this.logger.warn(
            `agent run paused session=${sessionId} steps=${result.iterations}/${MAX_ITERATIONS} elapsed=${elapsedMs}ms`,
          )
          this.rpc.notify(sessionId, { t: 'chat.text', delta: BUDGET_PAUSED_TEXT, channel: 'text' })
        } else {
          const reason = errorText(result.error || 'agent 运行失败')
          this.logger.warn(
            `agent run failed session=${sessionId} status=${result.status} steps=${result.iterations} elapsed=${elapsedMs}ms errorClass=${entry.errorClass ?? 'unknown'} error=${reason}`,
          )
          this.rpc.notify(sessionId, { t: 'chat.error', message: reason })
        }
      } else {
        this.logger.log(
          `agent run done session=${sessionId} status=${result.status} steps=${result.iterations} elapsed=${elapsedMs}ms endedBy=${turnEnd?.endedBy ?? 'model'}`,
        )
        // 收尾工具的产物（计划卡 / 问题卡 / 进度文本）统一在 run 结束时冲刷：
        // 顺序稳定（卡片 → chat.done），且"是否抑制兜底文本"只在一处判断。
        if (turnEnd) {
          for (const message of turnEnd.messages) this.rpc.notify(sessionId, message)
        }
        const suppressFallback = turnEnd?.suppressFallbackText === true
        if (!suppressFallback && !entry.streamedText && result.outputText) {
          this.rpc.notify(sessionId, { t: 'chat.text', delta: result.outputText, channel: 'text' })
          entry.streamedText = result.outputText
        }
      }
      // 过程区的折叠标题要「共 N 步 · X.Xs」——步数与总耗时都来自本轮 run
      this.rpc.notify(sessionId, {
        t: 'chat.done',
        steps: result.iterations,
        startedAt: session.activeRun.startedAt,
        durationMs: elapsedMs,
        ...(turnEnd ? { endedBy: turnEnd.endedBy } : {}),
      })
    } catch (error) {
      if (session.activeRun) {
        session.activeRun.status = 'failed'
        session.activeRun.updatedAt = Date.now()
      }
      this.logger.error(
        `agent run threw session=${sessionId}: ${errorText(error)}`,
        error instanceof Error ? error.stack : undefined,
      )
      throw error
    } finally {
      // 实例与订阅都活到会话结束（多轮复用），这里只解除「本会话正在跑」的标记。
      entry.running = false
    }
  }

  /** 本会话是否有 run 在执行（gateway 据此拒绝并发的 chat.send，避免两个 run 混流）。 */
  isRunning(sessionId: string): boolean {
    return this.sessionAgents.get(sessionId)?.running === true
  }

  /** 中止本会话运行中的 run（连接断开时调用：不再往已失效的连接推流）。 */
  abortSession(sessionId: string): void {
    this.abort(sessionId, 'connection closed')
  }

  cancel(sessionId: string): void {
    this.abort(sessionId, 'cancelled by user')
  }

  /**
   * 释放会话的长驻 agent 实例（连接断开时调用）。
   * 实例自带的对话上下文（`state.messages`）随之丢弃 —— 会话 = 连接，不做任何持久化。
   */
  disposeSession(sessionId: string): void {
    const entry = this.sessionAgents.get(sessionId)
    if (!entry) return
    this.sessionAgents.delete(sessionId)
    entry.unsubscribe()
    this.logger.debug(`agent disposed session=${sessionId} (sessions=${this.sessionAgents.size})`)
  }

  private abort(sessionId: string, reason: string): void {
    const entry = this.sessionAgents.get(sessionId)
    if (!entry?.running) {
      this.logger.debug(`agent abort session=${sessionId} 忽略：没有正在运行的 agent`)
      return
    }
    this.logger.log(`agent abort session=${sessionId} reason=${reason}`)
    entry.agent.abort(reason)
  }
}
