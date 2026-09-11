// 自定义 WS adapter：直接用 ws 包处理 { t: '...', ... } 协议格式。
// 背景：NestJS 官方 WsAdapter 的 messageParser 与 RxJS fromEvent 的参数包装有兼容问题
// （ws 的 'message' 事件带 (data, isBinary) 两个参数，fromEvent 会包成数组导致解析失败）。
import { AbstractWsAdapter } from '@nestjs/websockets'
import { Logger } from '@nestjs/common'
import type { Observable, Subscription } from 'rxjs'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'

interface WsHandler {
  message: string
  callback: (data: unknown, event?: string) => unknown
}

export class DirectWsAdapter extends AbstractWsAdapter {
  private readonly logger = new Logger(DirectWsAdapter.name)
  private wsServer: WebSocketServer | null = null

  /** port=0（UNDERLYING_HTTP_SERVER_PORT）时复用主 HTTP server，noServer 模式 */
  create(port: number, options: { server?: unknown; path?: string }) {
    if (this.httpServer && port === 0) {
      this.wsServer = new WebSocketServer({ noServer: true })
      this.httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`)
        if (url.pathname === (options.path || '/')) {
          this.logger.debug(`ws upgrade accepted: ${url.pathname}`)
          this.wsServer!.handleUpgrade(req, socket, head, (wsSocket) => {
            this.wsServer!.emit('connection', wsSocket, req)
          })
        } else {
          this.logger.warn(`ws upgrade rejected: ${url.pathname}（仅接受 ${options.path || '/'}）`)
          socket.destroy()
        }
      })
      return this.wsServer
    }
    this.logger.log(`ws server listening on port ${port} path ${options.path || '/'}`)
    this.wsServer = new WebSocketServer({ port, path: options.path })
    return this.wsServer
  }

  /**
   * 基类 AbstractWsAdapter 监听的是 'disconnect'（socket.io 事件），而 ws 的 Socket 只发 'close'，
   * 导致 handleDisconnect 永远不会触发（session / rpc socket 无法清理）。
   * 这里按官方 platform-ws 适配器的做法改监听 'close'。
   */
  override bindClientDisconnect(client: unknown, callback: () => void): void {
    const ws = client as WebSocket
    ws.on('close', () => {
      this.logger.debug('ws client closed, dispatch disconnect')
      callback()
    })
  }

  bindMessageHandlers(
    client: unknown,
    handlers: WsHandler[],
    transform: (val: unknown) => Observable<unknown>,
  ) {
    const handlersMap = new Map(handlers.map((h) => [h.message, h]))
    const ws = client as WebSocket
    const subs = new Set<Subscription>()

    ws.once('close', () => {
      for (const sub of subs) sub.unsubscribe()
      subs.clear()
      this.logger.debug('ws client closed, message handlers unsubscribed')
    })

    ws.on('message', (raw: Buffer | string) => {
      let msg: { t?: string }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        this.logger.warn(`ws 收到非 JSON 消息，已丢弃：${raw.toString().slice(0, 200)}`)
        return
      }
      if (!msg.t) {
        this.logger.warn('ws 收到缺少 t 字段的消息，已丢弃')
        return
      }
      const handler = handlersMap.get(msg.t)
      if (!handler) {
        this.logger.warn(`ws 收到未知消息类型 ${msg.t}，已丢弃`)
        return
      }
      this.logger.debug(`ws recv ${msg.t}`)

      try {
        // handler.callback 已被 NestJS 用 .bind(instance, client) 包装
        const result = handler.callback(msg, msg.t)
        const obs$ = transform(result)
        const sub = obs$.subscribe((response) => {
          // 过滤 void/undefined 响应：fire-and-forget 的 handler（如 chat.send）
          // 会返回 undefined，序列化后是空帧，客户端 JSON.parse 会崩
          if (response === undefined || response === null) return
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response))
        })
        subs.add(sub)
      } catch (err) {
        this.logger.error(
          `ws handler ${msg.t} 执行失败：${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        )
      }
    })
  }
}