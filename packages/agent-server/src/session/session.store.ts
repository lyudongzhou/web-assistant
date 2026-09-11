import type { AgentSession } from '@webassistant/protocol/session'

export interface SessionStore {
  get(id: string): AgentSession | undefined
  set(session: AgentSession): void
  delete(id: string): void
  values(): Iterable<AgentSession>
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>()

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  set(session: AgentSession): void {
    this.sessions.set(session.id, session)
  }

  delete(id: string): void {
    this.sessions.delete(id)
  }

  values(): Iterable<AgentSession> {
    return this.sessions.values()
  }
}
