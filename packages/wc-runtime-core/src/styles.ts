// 样式登记表：分层（base=UI 库 → shared=跨容器 tokens → page=页面）+ 按 id 去重 + append-only。
// append-only 是有意的：容器只需在 stylesVersion 变化时把「新增部分」追加进 shadow root，
// 不重排已有 <style>，避免切页闪烁。
import type { Unsubscribe } from './types.js'

export type StyleLayer = 'base' | 'shared' | 'page'

const LAYER_ORDER: StyleLayer[] = ['base', 'shared', 'page']

export interface StyleRegistry {
  readonly version: number
  /** 新增一段样式；重复 id 返回 false（不改变 version） */
  add(layer: StyleLayer, id: string, css: string): boolean
  addMany(layer: StyleLayer, id: string, cssList: readonly string[]): boolean
  has(layer: StyleLayer, id: string): boolean
  /** 按 base → shared → page 顺序返回全部样式文本 */
  toArray(): readonly string[]
  subscribe(listener: (version: number) => void): Unsubscribe
  dispose(): void
}

export function createStyleRegistry(): StyleRegistry {
  const layers = new Map<StyleLayer, string[]>(LAYER_ORDER.map((l) => [l, []]))
  const seen = new Set<string>()
  const listeners = new Set<(version: number) => void>()
  let version = 0
  let snapshot: readonly string[] = []
  let dirty = false

  function key(layer: StyleLayer, id: string): string {
    return `${layer}::${id}`
  }

  function bump(): void {
    version += 1
    dirty = true
    for (const listener of [...listeners]) listener(version)
  }

  return {
    get version() {
      return version
    },
    add(layer, id, css) {
      if (!css || seen.has(key(layer, id))) return false
      seen.add(key(layer, id))
      layers.get(layer)!.push(css)
      bump()
      return true
    },
    addMany(layer, id, cssList) {
      let changed = false
      cssList.forEach((css, index) => {
        // 同一来源的多段样式用下标区分 id，保证幂等
        if (this.add(layer, `${id}#${index}`, css)) changed = true
      })
      return changed
    },
    has(layer, id) {
      return seen.has(key(layer, id))
    },
    toArray() {
      if (dirty || snapshot.length === 0) {
        const out: string[] = []
        for (const layer of LAYER_ORDER) out.push(...layers.get(layer)!)
        snapshot = out
        dirty = false
      }
      return snapshot
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
