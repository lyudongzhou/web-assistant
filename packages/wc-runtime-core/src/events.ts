// 极简 typed 事件总线：runtime 内部广播，宿主通过 runtime.on 订阅。
import type { RuntimeEventMap, RuntimeEventName, Unsubscribe } from './types.js'

type Handler<E extends RuntimeEventName> = (payload: RuntimeEventMap[E]) => void

export interface EventBus {
  on<E extends RuntimeEventName>(event: E, handler: Handler<E>): Unsubscribe
  emit<E extends RuntimeEventName>(event: E, payload: RuntimeEventMap[E]): void
  clear(): void
}

export function createEventBus(): EventBus {
  const map = new Map<RuntimeEventName, Set<Handler<never>>>()
  return {
    on(event, handler) {
      let set = map.get(event)
      if (!set) {
        set = new Set()
        map.set(event, set)
      }
      set.add(handler as Handler<never>)
      return () => {
        set!.delete(handler as Handler<never>)
      }
    },
    emit(event, payload) {
      const set = map.get(event)
      if (!set) return
      // 复制一份，允许 handler 内部取消订阅
      for (const handler of [...set]) (handler as Handler<typeof event>)(payload)
    },
    clear() {
      map.clear()
    },
  }
}
