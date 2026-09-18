import { Inject, Injectable, Logger } from '@nestjs/common'
import crypto from 'node:crypto'
import { Agent, createTool } from '@cline/sdk'

interface AgentEventEnvelope {
  type: string
  iteration?: number
  text?: string
  toolCall?: { toolName: string }
  error?: unknown
  /** SDK 对 provider 错误的分类（run-failed 事件携带），便于定位失败原因 */
  errorClass?: string
}
import type {
  CallPageMethodToolArgs,
  RenderToolArgs,
  WaitForObservationToolArgs,
} from '@webassistant/protocol/websocket'
import type { AgentSession } from '@webassistant/protocol'
import { DEFAULT_MAX_TURN_MESSAGES, projectTurnMessages } from './turnProjection.js'
import { ManifestService } from '../manifest/manifest.service.js'
import { SessionService } from '../session/session.service.js'
import { RpcService } from '../rpc/rpc.service.js'
import { truncate, errorText } from '../logging.js'

const MAX_ITERATIONS = Number(process.env.MAX_AGENT_STEPS || 6)
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_CALL_TIMEOUT_MS || 8_000)
const OBSERVATION_TIMEOUT_MS = Number(process.env.OBSERVATION_WAIT_TIMEOUT_MS || 10_000)

/** 工具名 → 「agent.step」事件给用户看的简短文案 */
const TOOL_STEP_TEXT: Record<string, string> = {
  render: '正在打开页面',
  wait_for_observation: '正在等待页面数据',
  call_page_method: '正在调用页面方法',
}

/** 单次请求投影的消息上限（长驻 transcript 可能累积几十轮，避免 token 无界增长） */
const MAX_TURN_MESSAGES = Number(process.env.MAX_TURN_MESSAGES || DEFAULT_MAX_TURN_MESSAGES)

/**
 * config 里的 systemPrompt 只是兜底：真正下发的是 `prepareTurn` 每轮投影出来的
 * `buildAgentContext(session)`（含 manifest / 规则 / 当前页可用方法 / 最近观察）。
 */
const STATIC_SYSTEM_PROMPT =
  '你是一个网页助手：用工具操作被服务的网页（打开页面 / 等待数据 / 调用页面方法），并简洁回答用户。' +
  '每一轮的可用页面、规则、当前页可用方法与最近观察由宿主在请求前注入，请以那一份为准。'

/** Agent 构造参数与 `prepareTurn` 上下文（SDK 未导出后者，从构造签名里取，避免依赖内部路径）。 */
type AgentRuntimeConfig = ConstructorParameters<typeof Agent>[0]
type PrepareTurnContext = Parameters<NonNullable<AgentRuntimeConfig['prepareTurn']>>[0]

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

    const entry: SessionAgentEntry = {
      agent: new Agent({
        providerId: 'openai-compatible',
        modelId: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
        // 只放稳定内容；易变上下文（manifest / 当前页 / 观察）由 prepareTurn 每轮注入
        systemPrompt: STATIC_SYSTEM_PROMPT,
        tools: [renderTool, waitTool, callPageMethodTool],
        maxIterations: MAX_ITERATIONS,
        sessionId,
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
    }
    // 订阅一次、活到会话结束：流式文本与工具轨迹持续回推给本连接
    entry.unsubscribe = entry.agent.subscribe((rawEvent: unknown) => {
      const event = rawEvent as AgentEventEnvelope
      if (event.type === 'run-failed') entry.errorClass = event.errorClass
      if (event.type === 'assistant-text-delta' && event.text) {
        entry.streamedText += event.text
        this.rpc.notify(sessionId, { t: 'chat.text', delta: event.text })
      }
      if (event.type === 'tool-started' && event.toolCall) {
        const label = TOOL_STEP_TEXT[event.toolCall.toolName] || `正在执行 ${event.toolCall.toolName}`
        this.logger.debug(
          `agent step session=${sessionId} iteration=${event.iteration ?? 0} tool=${event.toolCall.toolName}`,
        )
        this.rpc.notify(sessionId, {
          t: 'agent.step',
          index: event.iteration || 0,
          text: label,
        })
      }
    })
    this.sessionAgents.set(sessionId, entry)
    this.logger.debug(`agent created session=${sessionId} (sessions=${this.sessionAgents.size})`)
    return entry
  }

  async run(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.find(sessionId)
    if (!session) throw new Error('session not found')
    const entry = this.getOrCreateAgent(session)
    if (entry.running) throw new Error('agent runtime is already running')
    entry.running = true
    entry.streamedText = ''
    entry.errorClass = undefined
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
      `agent run start session=${sessionId} runId=${session.activeRun.id} goal="${truncate(text)}"`,
    )

    try {
      const result = await entry.agent.run(text)
      const elapsedMs = Date.now() - session.activeRun.startedAt
      session.activeRun.status = result.status === 'aborted' ? 'cancelled' : result.status === 'failed' ? 'failed' : 'completed'
      session.activeRun.stepCount = result.iterations
      session.activeRun.updatedAt = Date.now()
      if (result.error || result.status === 'failed') {
        const reason = errorText(result.error || 'agent 运行失败')
        this.logger.warn(
          `agent run failed session=${sessionId} status=${result.status} steps=${result.iterations} elapsed=${elapsedMs}ms errorClass=${entry.errorClass ?? 'unknown'} error=${reason}`,
        )
        this.rpc.notify(sessionId, { t: 'chat.error', message: reason })
      } else {
        this.logger.log(
          `agent run done session=${sessionId} status=${result.status} steps=${result.iterations} elapsed=${elapsedMs}ms`,
        )
        if (!entry.streamedText && result.outputText) {
          this.rpc.notify(sessionId, { t: 'chat.text', delta: result.outputText })
          entry.streamedText = result.outputText
        }
      }
      this.rpc.notify(sessionId, { t: 'chat.done', steps: result.iterations })
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
