import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type {
  ToolArgs,
  ToolCallMessage,
  ToolName,
  ToolResultMessage,
} from '@webassistant/protocol/websocket'
import { truncate } from '../logging.js'

export interface RpcSocket {
  send(data: string): void
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; timedOut?: boolean }

interface PendingCall {
  sessionId: string
  timer: NodeJS.Timeout
  resolve: (result: ToolResult) => void
}

const DEFAULT_TOOL_TIMEOUT_MS = 8_000

/** Agent -> browser 的 Tool RPC。每个调用都有独立超时，断线不会留下悬挂 Promise。 */
@Injectable()
export class RpcService {
  private readonly logger = new Logger(RpcService.name)
  private readonly sockets = new Map<string, RpcSocket>()
  private readonly pending = new Map<string, PendingCall>()

  register(sessionId: string, socket: RpcSocket): void {
    this.sockets.set(sessionId, socket)
    this.logger.debug(`rpc register session=${sessionId} (sockets=${this.sockets.size})`)
  }

  notify(sessionId: string, message: unknown): boolean {
    const socket = this.sockets.get(sessionId)
    if (!socket) {
      this.logger.warn(`rpc notify session=${sessionId} 失败：client not connected`)
      return false
    }
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch (error) {
      this.logger.warn(
        `rpc notify session=${sessionId} 发送失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  unregister(sessionId: string, socket: RpcSocket): void {
    if (this.sockets.get(sessionId) !== socket) return
    this.sockets.delete(sessionId)
    let aborted = 0
    for (const [id, call] of this.pending) {
      if (call.sessionId !== sessionId) continue
      clearTimeout(call.timer)
      this.pending.delete(id)
      call.resolve({ ok: false, error: 'client disconnected', timedOut: true })
      aborted += 1
    }
    this.logger.log(
      `rpc unregister session=${sessionId} (sockets=${this.sockets.size}${aborted ? `, aborted pending=${aborted}` : ''})`,
    )
  }

  call(
    sessionId: string,
    name: ToolName,
    args: ToolArgs,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  ): Promise<ToolResult> {
    const socket = this.sockets.get(sessionId)
    if (!socket) {
      this.logger.warn(`tool.call session=${sessionId} ${name} 失败：client not connected`)
      return Promise.resolve({ ok: false, error: 'client not connected', timedOut: true })
    }

    const id = randomUUID()
    const message: ToolCallMessage = { t: 'tool.call', id, name, args, timeoutMs }
    this.logger.log(`tool.call -> session=${sessionId} name=${name} id=${id} args=${truncate(args)} timeout=${timeoutMs}ms`)
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.logger.warn(`tool.call <- session=${sessionId} name=${name} id=${id} 超时（>${timeoutMs}ms）`)
        resolve({ ok: false, error: `tool call timed out after ${timeoutMs}ms`, timedOut: true })
      }, timeoutMs)
      this.pending.set(id, { sessionId, timer, resolve })
      try {
        socket.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        const reason = error instanceof Error ? error.message : String(error)
        this.logger.error(`tool.call session=${sessionId} name=${name} id=${id} 发送失败：${reason}`)
        resolve({ ok: false, error: reason })
      }
    })
  }

  resolve(sessionId: string, message: ToolResultMessage): boolean {
    const call = this.pending.get(message.id)
    if (!call || call.sessionId !== sessionId) {
      this.logger.warn(
        `tool.result session=${sessionId} id=${message.id} 没有匹配的 pending 调用（可能已超时/断连）`,
      )
      return false
    }
    clearTimeout(call.timer)
    this.pending.delete(message.id)
    call.resolve(message.ok ? { ok: true, data: message.data } : {
      ok: false,
      error: message.error,
      timedOut: message.timedOut,
    })
    return true
  }

  pendingCount(sessionId?: string): number {
    if (!sessionId) return this.pending.size
    return [...this.pending.values()].filter((call) => call.sessionId === sessionId).length
  }
}
