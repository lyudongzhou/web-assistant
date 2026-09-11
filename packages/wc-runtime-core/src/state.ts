// 宿主业务状态的单向桥：core 只存纯数据 + 浅合并 + 通知。
// 为什么不能直接把宿主 store 传进来：宿主与 runtime 是两份框架副本，
// 宿主 store 的响应式依赖收集发生在宿主副本里，runtime 侧的渲染 effect 不会被登记，
// 结果是「首次能读到、之后不更新」。所以统一走「宿主监听 → 推快照 → runtime 侧自己的响应式副本」。
import type { Unsubscribe } from './types.js'

export type StatePatch = Record<string, unknown>

export interface StateBridge {
  /** 稳定引用的纯数据对象（浅合并写入同一对象） */
  readonly current: StatePatch
  get(): StatePatch
  /** 浅合并；返回真正发生变化的 key 列表（无变化则为空数组，不通知） */
  set(patch: StatePatch): string[]
  subscribe(listener: (patch: StatePatch, keys: string[]) => void): Unsubscribe
  dispose(): void
}

export function createStateBridge(initial: StatePatch = {}): StateBridge {
  const state: StatePatch = { ...initial }
  const listeners = new Set<(patch: StatePatch, keys: string[]) => void>()

  return {
    get current() {
      return state
    },
    get() {
      return { ...state }
    },
    set(patch) {
      const keys: string[] = []
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (Object.is(state[key], value)) continue
        state[key] = value
        keys.push(key)
      }
      if (keys.length) {
        const changed: StatePatch = {}
        for (const key of keys) changed[key] = state[key]
        for (const listener of [...listeners]) listener(changed, keys)
      }
      return keys
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      listeners.clear()
    },
  }
}
