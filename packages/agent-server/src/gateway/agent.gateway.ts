import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets'
import { Inject, Logger } from '@nestjs/common'
import type { AgentSession, ClientMessage, PageDataSnapshot, PageEmit } from '@webassistant/protocol'
import { SessionService } from '../session/session.service.js'
import { ManifestService } from '../manifest/manifest.service.js'
import { RpcService } from '../rpc/rpc.service.js'
import { AgentService } from '../agent/agent.service.js'
// 计划卡片的权威状态判定（`approvedAt` → proposed/approved）与收尾工具投影共用同一处，避免两处漂移
import { planCardStatus } from '../agent/turnEnd.js'
import { truncate, errorText } from '../logging.js'

interface ClientSocket {
  readyState: number
  send(data: string): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

interface ConnectionState {
  /** 连接序号，仅用于日志中标识一条连接（ws socket 对象本身 String() 后无信息量） */
  id: number
  session?: AgentSession
}

/** WebSocket 主链路的第一阶段：连接、Session、心跳和页面观察事件。 */
@WebSocketGateway({ path: '/ws' })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AgentGateway.name)
  private readonly connections = new Map<ClientSocket, ConnectionState>()
  private connSeq = 0

  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject(RpcService) private readonly rpc: RpcService,
    @Inject(AgentService) private readonly agents: AgentService,
  ) {}

  handleConnection(client: ClientSocket): void {
    const id = ++this.connSeq
    this.connections.set(client, { id })
    this.logger.log(`ws connected conn#${id} (online=${this.connections.size})`)
  }

  handleDisconnect(client: ClientSocket): void {
    const state = this.connections.get(client)
    if (state?.session) {
      // 会话 = 连接：断开即止损（abort 在跑的 run → 销毁会话 → 注销 RPC → 释放 agent 实例）。
      this.disposeSession(state.session.id, client)
    }
    this.connections.delete(client)
    this.logger.log(
      `ws disconnected conn#${state?.id ?? '?'}` +
        `${state?.session ? ` session=${state.session.id}` : ''} (online=${this.connections.size})`,
    )
  }

  /**
   * 会话回收（连接断开与同连接重复 hello 共用）：
   * 1. abort 运行中的 run（避免继续往已失效的连接推流）
   * 2. 销毁会话（含清理该会话的观察等待）
   * 3. 注销 RPC 通道（挂起的 tool.call 按断线语义失败）
   * 4. 释放该会话的长驻 agent 实例
   */
  private disposeSession(sessionId: string, client: ClientSocket): void {
    this.agents.abortSession(sessionId)
    this.sessions.destroy(sessionId)
    this.rpc.unregister(sessionId, client)
    this.agents.disposeSession(sessionId)
  }

  @SubscribeMessage('session.hello')
  handleHello(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'session.hello' }>,
  ) {
    const manifestVersion = this.manifests.getManifestVersion()
    if (message.manifestVersion !== manifestVersion) {
      this.logger.warn(
        `session.hello rejected: manifest version mismatch client=${message.manifestVersion} server=${manifestVersion}`,
      )
      return {
        t: 'chat.error' as const,
        message: `manifest version mismatch: client=${message.manifestVersion}, server=${manifestVersion}`,
      }
    }
    // 会话 = 连接：每次握手都新建会话，**不读取也不复用**入参 sessionId（刷新/重连即新会话）。
    // 同一连接重复 hello 时先按断开语义回收旧会话，避免留下游离会话。
    const state = this.connections.get(client) ?? { id: ++this.connSeq }
    if (state.session) this.disposeSession(state.session.id, client)
    const session = this.sessions.create()
    state.session = session
    this.connections.set(client, state)
    this.rpc.register(session.id, client)
    this.logger.log(
      `session.hello conn#${state.id} session=${session.id} manifestVersion=${manifestVersion}`,
    )

    // 每次建立连接都先说一段欢迎语（介绍能力，按 manifest 页面生成）。
    // session.ready 是本 handler 的返回值，Nest 在 return 之后同步发送；这里用 setTimeout(0)（宏任务）
    // 保证聊天气泡问候排在其后，客户端不会先收到 chat.text 再收到 session.ready。
    // 结构化载荷（welcome）随 session.ready 一并下发，供渲染区「欢迎页」渲染能力卡片。
    const welcome = this.manifests.buildWelcome()
    if (welcome) {
      setTimeout(() => {
        this.logger.debug(`welcome -> session=${session.id} capabilities=${welcome.capabilities.length}`)
        this.rpc.notify(session.id, { t: 'chat.text', delta: welcome.text, channel: 'text' })
        // 欢迎语不是一次 agent run：不带 startedAt/durationMs（过程区的耗时只属于真正的 run）
        this.rpc.notify(session.id, { t: 'chat.done', steps: 0 })
      }, 0)
    }

    return {
      t: 'session.ready' as const,
      sessionId: session.id,
      manifestVersion,
      ...(welcome ? { welcome } : {}),
    }
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() _client: ClientSocket) {
    this.logger.debug('ping -> pong')
    return { t: 'pong' as const }
  }

  @SubscribeMessage('chat.send')
  handleChatSend(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'chat.send' }>,
  ): void {
    const session = this.findSession(client)
    if (!session) return
    this.logger.log(
      `chat.send session=${session.id} mode=${message.mode ?? '-'} planId=${message.planId ?? '-'} revisePlanId=${message.revisePlanId ?? '-'} stepDoneId=${message.stepDoneId ?? '-'} questionId=${message.questionId ?? '-'} text="${truncate(message.text)}"`,
    )
    // 同一会话串行：长驻 agent runtime 正在跑时拒绝新的一轮（不再允许并发 run）。
    if (this.agents.isRunning(session.id)) {
      this.logger.warn(`chat.send session=${session.id} 拒绝：上一轮仍在进行中`)
      this.rpc.notify(session.id, { t: 'chat.error', message: '上一轮仍在进行中，请等它结束后再发送。' })
      return
    }
    // 回合边界的"用户回应"必须先落到 session 上，再起本轮 run —— 顺序反了会出两个问题：
    // ① 计划确认晚于本轮第一次 render → 会被 plan 门禁拦下（approvedAt 还是空的）；
    // ② 回答没记上 → 同一问题在下一轮被重复提问。
    // 「修改计划」（revisePlanId）不在这里落 session：它要等本轮 run 拿到 planId 后由
    // `AgentService.run()` 写成 `session.planTurn`（需要验证卡片是否过期）。
    this.resolveTurnEndInput(session, message)
    void this.agents.run(session.id, message.text, {
      ...(message.mode ? { mode: message.mode } : {}),
      ...(message.planId ? { planId: message.planId } : {}),
      ...(message.revisePlanId ? { revisePlanId: message.revisePlanId } : {}),
      ...(message.stepDoneId ? { stepDoneId: message.stepDoneId } : {}),
      ...(message.questionId ? { questionId: message.questionId } : {}),
    }).catch((error: unknown) => {
      const reason = errorText(error)
      this.logger.error(`chat.send session=${session.id} agent run failed: ${reason}`)
      this.rpc.notify(session.id, { t: 'chat.error', message: reason })
    })
  }

  /**
   * 处理本轮的"用户回应"（计划确认 / 人工步骤完成 / 问题回答）。
   *
   * - 确认计划：`planId` 命中当前计划才批准；不命中（期间重新规划过）时明确告知用户重新确认，
   *   而不是默默批准一个新计划。
   * - 完成人工步骤（`stepDoneId`）：命中当前等待中的那一步才推进；不命中时说清原因，
   *   本轮仍照常跑（否则客户端会卡在 loading）—— 但此时**不记回执**，模型不会被误导。
   * - 回答提问：带 `questionId` 要匹配；用户直接打字（不带 id）也算回答当前未回答的问题 ——
   *   否则"我问了一个问题，用户直接说答案"会被当成普通消息，问题一直挂着。
   */
  private resolveTurnEndInput(
    session: AgentSession,
    message: Extract<ClientMessage, { t: 'chat.send' }>,
  ): void {
    if (message.planId) {
      const outcome = this.sessions.approvePlan(session, message.planId)
      if (outcome === 'approved') {
        this.logger.log(`plan approved session=${session.id} planId=${message.planId}`)
      } else if (outcome === 'stale') {
        this.logger.warn(`plan approve stale session=${session.id} planId=${message.planId}（当前计划已更新）`)
        this.rpc.notify(session.id, {
          t: 'chat.text',
          delta: '计划已经更新过了，请在上面的计划卡上重新点「开始执行」。',
          channel: 'text',
        })
      }
    }
    if (message.stepDoneId) {
      const outcome = this.sessions.completeUserStep(session, message.planId, message.stepDoneId)
      if (outcome === 'done') {
        this.logger.log(`user step done session=${session.id} stepId=${message.stepDoneId}`)
        // 立刻把"该步已完成"的权威卡片推回去。不推的话客户端只能等下一张卡片，而那一轮很可能
        // 一张都不推（模型直接继续下一步、或 finish_turn 只推文本）—— 界面会一直停在"轮到你操作"，
        // 用户以为白点了。卡片用服务端权威状态（客户端不本地推进，见 add-plan-manual-steps D5）。
        const plan = session.plan
        if (plan) {
          this.rpc.notify(session.id, {
            t: 'chat.plan',
            planId: plan.id,
            summary: plan.summary,
            steps: plan.steps,
            createdAt: plan.createdAt,
            status: planCardStatus(plan),
            revision: plan.revision ?? 1,
            ...(plan.revisedAt != null ? { revisedAt: plan.revisedAt } : {}),
          })
        }
      } else {
        this.logger.warn(
          `user step done ignored session=${session.id} stepId=${message.stepDoneId} reason=${outcome}`,
        )
        this.rpc.notify(session.id, {
          t: 'chat.text',
          delta:
            outcome === 'stale'
              ? '计划已经更新过了，请在上面的计划卡上重新点「我已完成，下一步」。'
              : '这一步现在不需要你确认（可能已经推进过或计划变了），我按当前计划继续。',
          channel: 'text',
        })
      }
    }
    if (message.planId || message.stepDoneId) return
    const answered = this.sessions.answerQuestion(session, message.text, message.questionId)
    if (answered) {
      this.logger.log(`question answered session=${session.id} questionId=${session.pendingQuestion?.id}`)
    } else if (message.questionId) {
      this.logger.warn(`question answer stale session=${session.id} questionId=${message.questionId}`)
    }
  }

  @SubscribeMessage('chat.cancel')
  handleChatCancel(@ConnectedSocket() client: ClientSocket): void {
    const session = this.findSession(client)
    if (!session) return
    this.logger.log(`chat.cancel session=${session.id}`)
    this.agents.cancel(session.id)
  }

  @SubscribeMessage('tool.result')
  handleToolResult(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'tool.result' }>,
  ): void {
    const session = this.findSession(client)
    if (!session) return
    this.rpc.resolve(session.id, message)
    if (message.ok) this.logger.log(`tool.result session=${session.id} id=${message.id} ok`)
    else this.logger.warn(`tool.result session=${session.id} id=${message.id} failed: ${truncate(message.error)}`)
  }

  @SubscribeMessage('page.navigated')
  handleNavigation(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.navigated' }>,
  ): void {
    const session = this.findSession(client)
    if (!session) return
    this.logger.log(`page.navigated session=${session.id} tag=${message.tag} source=${message.source}`)
    this.sessions.recordNavigation(session, {
      tag: message.tag,
      params: message.params,
      title: message.title,
      source: message.source,
      at: Date.now(),
    })
  }

  /** 调用方显式上报的数据快照（apiBus.report → page.data） */
  @SubscribeMessage('page.data')
  handlePageData(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.data' }>,
  ): void {
    const session = this.findSession(client)
    if (!session) return
    const { t, ...payload } = message
    this.logger.debug(
      `page.data session=${session.id} page=${message.page ?? '-'} source=${message.source} data=${truncate(message.data)}`,
    )
    this.sessions.recordObservation(session, {
      ...payload,
      type: 'page.data',
    } as PageDataSnapshot)
  }

  /** 页面 Vue `defineEmits` 事件 → 入 session.recentObservations（与 page.data 同构） */
  @SubscribeMessage('page.emit')
  handlePageEmit(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.emit' }>,
  ): void {
    const session = this.findSession(client)
    if (!session) return
    const { t, at, ...rest } = message
    this.logger.log(
      `page.emit session=${session.id} tag=${rest.tag} event=${rest.event} payload=${truncate(rest.payload)}`,
    )
    const emit: PageEmit = {
      type: 'page.emit',
      page: rest.tag,
      event: rest.event,
      payload: rest.payload,
      emittedAt: at ?? Date.now(),
    }
    this.sessions.recordObservation(session, emit)
  }

  /** 当前页 expose 能力清单（chat-client 接到 page-exposed-changed 时转发） */
  @SubscribeMessage('page.exposed')
  handlePageExposed(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.exposed' }>,
  ): void {
    // 暂不进 session.recentObservations（这是元数据，不是事件流）；
    // session 不持有 pageExposedKeys 也能工作 —— manifest.service 在 buildAgentContext 里读的是 manifest，
    // 当前页 tag 由 session.currentPage 给出；运行时「最新 keys」用最近一次 page.exposed 的覆盖。
    // MVP：仅做最小记录（最近一次），不做历史；后续如需 agent 跨页「记住了所有页的 expose」，扩 session 字段。
    const session = this.findSession(client)
    if (!session) return
    this.logger.log(`page.exposed session=${session.id} tag=${message.tag} keys=${truncate(message.keys, 300)}`)
    this.sessions.recordPageExposed(session, message)
  }

  /**
   * 取当前连接绑定的会话；没有则**返回 null 并记日志**（不抛异常）。
   * 断开后的迟到消息会落到这里（会话已随连接销毁），抛异常只会产生未捕获噪音。
   */
  private findSession(client: ClientSocket): AgentSession | null {
    const session = this.connections.get(client)?.session
    if (!session) {
      this.logger.warn('收到消息但连接没有有效会话（尚未 session.hello 或会话已随连接销毁），已忽略')
      return null
    }
    return session
  }
}
