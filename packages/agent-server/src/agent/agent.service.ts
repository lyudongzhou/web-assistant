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

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name)
  private readonly activeAgents = new Map<string, Agent>()

  constructor(
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(RpcService) private readonly rpc: RpcService,
  ) {}

  async run(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.find(sessionId)
    if (!session) throw new Error('session not found')
    this.sessions.addHistory(session, 'user', text)
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
    const pages = this.manifests.getPages()

    const renderTool = createTool<RenderToolArgs, unknown>({
      name: 'render',
      description: '打开页面。操作会立即确认，不代表页面数据已经返回。',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', enum: pages.map((page) => page.tag) },
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
      description: '等待页面出现与目标相关的网络响应、错误或超时。不要猜测未观察到的业务数据。',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          match: { type: 'object' },
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

    const agent = new Agent({
      providerId: 'openai-compatible',
      modelId: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      systemPrompt: this.manifests.buildAgentContext(session),
      tools: [renderTool, waitTool, callPageMethodTool],
      maxIterations: MAX_ITERATIONS,
      sessionId,
    })

    this.activeAgents.set(sessionId, agent)
    let assistantText = ''
    let errorClass: string | undefined
    const unsubscribe = agent.subscribe((rawEvent: unknown) => {
      const event = rawEvent as AgentEventEnvelope
      if (event.type === 'run-failed') errorClass = event.errorClass
      if (event.type === 'assistant-text-delta' && event.text) {
        assistantText += event.text
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

    try {
      const result = await agent.run(text)
      const elapsedMs = Date.now() - session.activeRun.startedAt
      session.activeRun.status = result.status === 'aborted' ? 'cancelled' : result.status === 'failed' ? 'failed' : 'completed'
      session.activeRun.stepCount = result.iterations
      session.activeRun.updatedAt = Date.now()
      if (result.error || result.status === 'failed') {
        const reason = errorText(result.error || 'agent 运行失败')
        this.logger.warn(
          `agent run failed session=${sessionId} status=${result.status} steps=${result.iterations} elapsed=${elapsedMs}ms errorClass=${errorClass ?? 'unknown'} error=${reason}`,
        )
        this.rpc.notify(sessionId, { t: 'chat.error', message: reason })
      } else {
        this.logger.log(
          `agent run done session=${sessionId} status=${result.status} steps=${result.iterations} elapsed=${elapsedMs}ms`,
        )
        if (!assistantText && result.outputText) {
          this.rpc.notify(sessionId, { t: 'chat.text', delta: result.outputText })
          assistantText = result.outputText
        }
      }
      if (assistantText) this.sessions.addHistory(session, 'assistant', assistantText)
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
      unsubscribe()
      this.activeAgents.delete(sessionId)
    }
  }

  cancel(sessionId: string): void {
    const agent = this.activeAgents.get(sessionId)
    if (!agent) {
      this.logger.debug(`agent cancel session=${sessionId} 忽略：没有正在运行的 agent`)
      return
    }
    this.logger.log(`agent cancel session=${sessionId}`)
    agent.abort('cancelled by user')
  }
}
