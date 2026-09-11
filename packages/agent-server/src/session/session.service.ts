import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type {
  AgentSession,
  CurrentPage,
  PageObservation,
  PageNetworkRequest,
  PageNetworkResponse,
  PageNetworkError,
  PageNetworkTimeout,
  ObservationMatch,
} from '@webassistant/protocol'
import { MemorySessionStore, type SessionStore } from './session.store.js'

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000)
const MAX_HISTORY = 10
const MAX_OBSERVATIONS = 100

export type ObservationWaitResult =
  | { status: 'completed'; observations: PageObservation[] }
  | { status: 'failed'; error: string }
  | { status: 'timed_out'; timeoutMs: number }

interface ObservationWaiter {
  sessionId: string
  match: ObservationMatch
  timer: NodeJS.Timeout
  resolve: (result: ObservationWaitResult) => void
}

@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly store: SessionStore = new MemorySessionStore()
  private readonly waiters = new Map<string, ObservationWaiter>()
  private readonly cleanupTimer: NodeJS.Timeout

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000)
    this.cleanupTimer.unref()
  }

  createOrResume(sessionId?: string): { session: AgentSession; resumed: boolean } {
    const existing = sessionId ? this.store.get(sessionId) : undefined
    if (existing) {
      existing.lastSeenAt = Date.now()
      return { session: existing, resumed: true }
    }

    const session: AgentSession = {
      id: sessionId || randomUUID(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      history: [],
      pendingRequests: new Map(),
      recentObservations: [],
    }
    this.store.set(session)
    return { session, resumed: false }
  }

  touch(session: AgentSession): void {
    session.lastSeenAt = Date.now()
  }

  bindSocket(session: AgentSession, socketId: string): void {
    session.socketId = socketId
    this.touch(session)
  }

  unbindSocket(session: AgentSession, socketId: string): void {
    if (session.socketId === socketId) session.socketId = undefined
    this.touch(session)
  }

  recordNavigation(session: AgentSession, page: CurrentPage): void {
    session.currentPage = page
    this.touch(session)
  }

  /**
   * 记录当前页 expose 能力清单（最近一次覆盖）。
   * Agent prompt 通过 session.pageExposedKeys + session.currentPage 拼出「当前页可用方法」。
   * 不进 recentObservations（这是元数据，不是事件流）。
   */
  recordPageExposed(
    session: AgentSession,
    payload: { tag: string; keys: string[] },
  ): void {
    if (!session.pageExposedKeys) session.pageExposedKeys = {}
    session.pageExposedKeys[payload.tag] = payload.keys
    this.touch(session)
  }

  recordObservation(session: AgentSession, observation: PageObservation): void {
    this.touch(session)
    if (observation.type === 'page.network.request') {
      session.pendingRequests.set(observation.requestId, observation)
    } else if (this.isNetworkTerminal(observation)) {
      session.pendingRequests.delete(observation.requestId)
    }
    session.recentObservations.push(observation)
    if (session.recentObservations.length > MAX_OBSERVATIONS) {
      session.recentObservations.splice(0, session.recentObservations.length - MAX_OBSERVATIONS)
    }
    this.resolveMatchingWaiters(session.id, observation)
  }

  waitForObservation(sessionId: string, match: ObservationMatch, timeoutMs: number): Promise<ObservationWaitResult> {
    const session = this.store.get(sessionId)
    if (!session) return Promise.resolve({ status: 'failed', error: 'session not found' })
    const existing = session.recentObservations.filter((observation) => (
      observation.type !== 'page.network.request' && this.matches(observation, match)
    ))
    if (existing.length) return Promise.resolve({ status: 'completed', observations: existing })

    return new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        resolve({ status: 'timed_out', timeoutMs })
      }, timeoutMs)
      this.waiters.set(id, { sessionId, match, timer, resolve })
    })
  }

  addHistory(session: AgentSession, role: 'user' | 'assistant' | 'system', content: string): void {
    session.history.push({ role, content, createdAt: Date.now() })
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY)
    }
    this.touch(session)
  }

  find(sessionId: string): AgentSession | undefined {
    return this.store.get(sessionId)
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer)
    for (const waiter of this.waiters.values()) clearTimeout(waiter.timer)
    this.waiters.clear()
  }

  private resolveMatchingWaiters(sessionId: string, observation: PageObservation): void {
    for (const [id, waiter] of this.waiters) {
      if (
        waiter.sessionId !== sessionId
        || observation.type === 'page.network.request'
        || !this.matches(observation, waiter.match)
      ) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(id)
      if (observation.type === 'page.network.error') waiter.resolve({ status: 'failed', error: observation.error })
      else waiter.resolve({ status: 'completed', observations: [observation] })
    }
  }

  private matches(observation: PageObservation, match: ObservationMatch): boolean {
    if (match.page && observation.page !== match.page) return false
    if (match.requestId && ('requestId' in observation) && observation.requestId !== match.requestId) return false
    if (match.method && ('method' in observation) && observation.method.toUpperCase() !== match.method.toUpperCase()) return false
    if (match.url && ('url' in observation) && !observation.url.includes(match.url)) return false
    if (match.contains) {
      // emit / data / visible 这类不带 URL 的事件：按 contains 在序列化 JSON 里匹配
      if (observation.type === 'page.emit') {
        const haystack = `${observation.event}\n${JSON.stringify(observation.payload ?? null)}`
        if (!haystack.includes(match.contains)) return false
      } else if ('url' in observation) {
        const text = `${observation.url}\n${JSON.stringify(observation)}`
        if (!text.includes(match.contains)) return false
      } else {
        const text = JSON.stringify(observation)
        if (!text.includes(match.contains)) return false
      }
    }
    return true
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const session of this.store.values()) {
      if (now - session.lastSeenAt > SESSION_TTL_MS) this.store.delete(session.id)
    }
  }

  private isNetworkTerminal(
    observation: PageObservation,
  ): observation is PageNetworkResponse | PageNetworkError | PageNetworkTimeout {
    return observation.type === 'page.network.response'
      || observation.type === 'page.network.error'
      || observation.type === 'page.network.timeout'
  }
}

