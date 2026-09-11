import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets'
import { Inject, Logger } from '@nestjs/common'
import type { AgentSession, ClientMessage, PageObservation, PageDataSnapshot, PageEmit } from '@webassistant/protocol'
import { SessionService } from '../session/session.service.js'
import { ManifestService } from '../manifest/manifest.service.js'
import { RpcService } from '../rpc/rpc.service.js'
import { AgentService } from '../agent/agent.service.js'
import { truncate, errorText } from '../logging.js'

interface ClientSocket {
  readyState: number
  send(data: string): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

type WireObservation = Extract<
  ClientMessage,
  {
    t:
      | 'page.network.request'
      | 'page.network.response'
      | 'page.network.error'
      | 'page.network.timeout'
  }
>

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
      this.rpc.unregister(state.session.id, client)
      this.sessions.unbindSocket(state.session, this.socketId(client))
    }
    this.connections.delete(client)
    this.logger.log(
      `ws disconnected conn#${state?.id ?? '?'}` +
        `${state?.session ? ` session=${state.session.id}` : ''} (online=${this.connections.size})`,
    )
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
    const { session, resumed } = this.sessions.createOrResume(message.sessionId)
    const state = this.connections.get(client) ?? { id: ++this.connSeq }
    if (state.session && state.session.id !== session.id) {
      this.sessions.unbindSocket(state.session, this.socketId(client))
    }
    state.session = session
    this.connections.set(client, state)
    this.sessions.bindSocket(session, this.socketId(client))
    this.rpc.register(session.id, client)
    this.logger.log(
      `session.hello conn#${state.id} session=${session.id} resumed=${resumed} manifestVersion=${manifestVersion}`,
    )
    return {
      t: 'session.ready' as const,
      sessionId: session.id,
      resumed,
      manifestVersion,
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
    const session = this.requireSession(client)
    this.logger.log(`chat.send session=${session.id} text="${truncate(message.text)}"`)
    void this.agents.run(session.id, message.text).catch((error: unknown) => {
      const reason = errorText(error)
      this.logger.error(`chat.send session=${session.id} agent run failed: ${reason}`)
      this.rpc.notify(session.id, { t: 'chat.error', message: reason })
    })
  }

  @SubscribeMessage('chat.cancel')
  handleChatCancel(@ConnectedSocket() client: ClientSocket): void {
    const session = this.requireSession(client)
    this.logger.log(`chat.cancel session=${session.id}`)
    this.agents.cancel(session.id)
  }

  @SubscribeMessage('tool.result')
  handleToolResult(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'tool.result' }>,
  ): void {
    const session = this.requireSession(client)
    this.rpc.resolve(session.id, message)
    if (message.ok) this.logger.log(`tool.result session=${session.id} id=${message.id} ok`)
    else this.logger.warn(`tool.result session=${session.id} id=${message.id} failed: ${truncate(message.error)}`)
  }

  @SubscribeMessage('page.navigated')
  handleNavigation(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.navigated' }>,
  ): void {
    const session = this.requireSession(client)
    this.logger.log(`page.navigated session=${session.id} tag=${message.tag} source=${message.source}`)
    this.sessions.recordNavigation(session, {
      tag: message.tag,
      params: message.params,
      title: message.title,
      source: message.source,
      at: Date.now(),
    })
  }

  /** 页面手动上报的数据快照（apiBus.report → page.data） */
  @SubscribeMessage('page.data')
  handlePageData(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.data' }>,
  ): void {
    const session = this.requireSession(client)
    const { t, ...payload } = message
    this.logger.debug(
      `page.data session=${session.id} page=${message.page ?? '-'} source=${message.source} data=${truncate(message.data)}`,
    )
    this.sessions.recordObservation(session, {
      ...payload,
      type: 'page.data',
    } as PageDataSnapshot)
  }

  @SubscribeMessage('page.network.request')
  handleNetworkRequest(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.network.request' }>,
  ): void {
    this.recordObservation(client, message)
  }

  @SubscribeMessage('page.network.response')
  handleNetworkResponse(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.network.response' }>,
  ): void {
    this.recordObservation(client, message)
  }

  @SubscribeMessage('page.network.error')
  handleNetworkError(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.network.error' }>,
  ): void {
    this.recordObservation(client, message)
  }

  @SubscribeMessage('page.network.timeout')
  handleNetworkTimeout(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.network.timeout' }>,
  ): void {
    this.recordObservation(client, message)
  }

  /** 页面 Vue `defineEmits` 事件 → 入 session.recentObservations（与 page.data/page.network.* 同构） */
  @SubscribeMessage('page.emit')
  handlePageEmit(
    @ConnectedSocket() client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.emit' }>,
  ): void {
    const session = this.requireSession(client)
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
    @ConnectedSocket() _client: ClientSocket,
    @MessageBody() message: Extract<ClientMessage, { t: 'page.exposed' }>,
  ): void {
    // 暂不进 session.recentObservations（这是元数据，不是事件流）；
    // session 不持有 pageExposedKeys 也能工作 —— manifest.service 在 buildAgentContext 里读的是 manifest，
    // 当前页 tag 由 session.currentPage 给出；运行时「最新 keys」用最近一次 page.exposed 的覆盖。
    // MVP：仅做最小记录（最近一次），不做历史；后续如需 agent 跨页「记住了所有页的 expose」，扩 session 字段。
    const session = this.requireSession(_client)
    this.logger.log(`page.exposed session=${session.id} tag=${message.tag} keys=${truncate(message.keys, 300)}`)
    this.sessions.recordPageExposed(session, message)
  }

  private recordObservation(client: ClientSocket, message: WireObservation): void {
    const session = this.requireSession(client)
    const { t, ...payload } = message
    const detail =
      'status' in payload
        ? `${payload.method} ${truncate(payload.url, 120)} -> ${payload.status}`
        : 'error' in payload
          ? `${payload.method} ${truncate(payload.url, 120)} !! ${truncate(payload.error, 120)}`
          : `${payload.method} ${truncate(payload.url, 120)}`
    this.logger.debug(`${t} session=${session.id} ${detail}`)
    this.sessions.recordObservation(session, {
      ...payload,
      type: t,
    } as PageObservation)
  }

  private requireSession(client: ClientSocket): AgentSession {
    const session = this.connections.get(client)?.session
    if (!session) {
      this.logger.warn('收到消息但连接尚未 session.hello，已拒绝')
      throw new Error('session.hello required')
    }
    return session
  }

  private socketId(client: ClientSocket): string {
    return String(client)
  }
}
