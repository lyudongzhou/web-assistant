// services 的稳定引用容器：引用永不变（可 provide 一次），内容可被 setServices 替换。
// 同时对「误传框架响应式实例」做运行时告警 —— 这是跨副本最常见的坑。
import { createStateBridge, type StateBridge, type StatePatch } from './state.js'
import type { RuntimeServices, ServicesChange, ServicesRef } from './types.js'

export interface MutableServicesRef extends ServicesRef {
  set(patch: Partial<RuntimeServices>): string[]
  setState(patch: StatePatch): string[]
  readonly stateBridge: StateBridge
  dispose(): void
}

/** 识别框架响应式对象：vue ref/reactive、pinia 实例、vue-i18n 实例 */
export function looksFrameworkBound(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (obj.__v_isRef) return 'vue ref'
  if (obj.__v_isReactive || obj.__v_raw) return 'vue reactive'
  if (obj._s && obj._e) return 'pinia 实例'
  if (obj.global && obj.mode && typeof obj.install === 'function') return 'vue-i18n 实例'
  return null
}

const NEUTRAL_KEYS = new Set(['state', 'extras', 'theme'])

function warnFrameworkBound(patch: Partial<RuntimeServices>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (NEUTRAL_KEYS.has(key)) continue
    const kind = looksFrameworkBound(value)
    if (!kind) continue
    console.warn(
      `[wc-runtime] services.${key} 看起来是「${kind}」。宿主与 runtime 是两份框架副本，` +
        '响应式依赖不互通，页面能读到值但不会随之更新。请改传纯函数/纯数据，' +
        '业务状态用 runtime.setState() 推快照。',
    )
  }
}

export function createServicesRef(initial: RuntimeServices = {}): MutableServicesRef {
  const { state: initialState, ...rest } = initial
  const stateBridge = createStateBridge(initialState ?? {})
  const listeners = new Set<(ref: ServicesRef, change: ServicesChange) => void>()
  warnFrameworkBound(rest)

  let current: RuntimeServices = { ...rest, state: stateBridge.current }

  const ref: MutableServicesRef = {
    get current() {
      return current
    },
    get state() {
      return stateBridge.current
    },
    get stateBridge() {
      return stateBridge
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(patch) {
      const { state: statePatch, ...others } = patch
      warnFrameworkBound(others)
      const keys: string[] = []
      for (const [key, value] of Object.entries(others)) {
        if (Object.is((current as Record<string, unknown>)[key], value)) continue
        keys.push(key)
      }
      if (keys.length) {
        current = { ...current, ...others, state: stateBridge.current }
        notify({ kind: 'services', keys })
      }
      if (statePatch) ref.setState(statePatch)
      return keys
    },
    setState(patch) {
      const keys = stateBridge.set(patch)
      if (keys.length) notify({ kind: 'state', keys })
      return keys
    },
    dispose() {
      listeners.clear()
      stateBridge.dispose()
    },
  }

  function notify(change: ServicesChange): void {
    for (const listener of [...listeners]) listener(ref, change)
  }

  return ref
}
