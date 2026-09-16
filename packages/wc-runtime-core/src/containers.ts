// 容器管理：每个 framework 一个容器 WC，按需懒建。
// 「这批 WC 是 vue、那批是 react」→ 各自的容器 bundle 自带框架与 UI 库，互不共享、互不污染。
import type { BundleLoader } from './loader.js'
import type {
  ContainerDescriptor,
  ContainerModule,
  ContainerStrategy,
  RuntimeAdapter,
  RuntimeNavApi,
  RuntimeView,
  ServicesRef,
} from './types.js'

export interface ContainerEntry {
  framework: string
  tagName: string
  adapter: RuntimeAdapter
  handle: unknown
  mounted: boolean
}

export interface ContainerManagerOptions {
  containers: readonly ContainerDescriptor[]
  /** 预注册的 adapter（无需容器 bundle，直接可用） */
  adapters?: readonly RuntimeAdapter[]
  loader: BundleLoader
  servicesRef: ServicesRef
  navigation: RuntimeNavApi
  strategy?: ContainerStrategy
  /** 页面事件回传通道，透传给每个容器 */
  onPageEvent?: (payload: { tag: string; event: string; payload?: unknown }) => void
}

export interface ContainerManager {
  setRoot(root: Element): void
  ensure(framework: string): Promise<ContainerEntry>
  get(framework: string): ContainerEntry | undefined
  patch(framework: string, view: RuntimeView): void
  /** 切到别的框架时，把其余容器清空（keep）或卸载（unmount） */
  deactivateOthers(active: string, stylesVersion: number): void
  dispose(): void
}

const EMPTY_VIEW = (framework: string, stylesVersion: number): RuntimeView => ({
  framework,
  tag: null,
  props: {},
  styles: [],
  stylesVersion,
  status: 'idle',
  events: [],
})

export function createContainerManager(options: ContainerManagerOptions): ContainerManager {
  const strategy = options.strategy ?? 'keep'
  const descriptors = new Map(options.containers.map((item) => [item.framework, item]))
  const preRegistered = new Map((options.adapters ?? []).map((item) => [item.framework, item]))
  const entries = new Map<string, ContainerEntry>()
  const inflight = new Map<string, Promise<ContainerEntry>>()
  let root: Element | null = null

  async function resolveAdapter(framework: string): Promise<RuntimeAdapter> {
    const local = preRegistered.get(framework)
    if (local) return local
    const descriptor = descriptors.get(framework)
    if (!descriptor?.bundle) {
      throw new Error(
        `framework「${framework}」既没有预注册 adapter，manifest.containers 也没给 bundle`,
      )
    }
    const mod = await options.loader.load<ContainerModule>(descriptor.bundle)
    const adapter = mod?.default ?? mod?.adapter
    if (!adapter || typeof adapter.defineContainer !== 'function') {
      throw new Error(`容器 bundle ${descriptor.bundle} 未默认导出合法 adapter`)
    }
    if (adapter.framework !== framework) {
      throw new Error(
        `容器 bundle ${descriptor.bundle} 声明的 framework 是「${adapter.framework}」，` +
          `与 manifest 的「${framework}」不一致`,
      )
    }
    return adapter
  }

  function create(framework: string): Promise<ContainerEntry> {
    const task = resolveAdapter(framework).then((adapter) => {
      const tagName =
        descriptors.get(framework)?.tagName || adapter.defaultTagName || `runtime-${framework}`
      const handle = adapter.defineContainer({
        tagName,
        servicesRef: options.servicesRef,
        navigation: options.navigation,
        onPageEvent: options.onPageEvent,
      })
      const entry: ContainerEntry = { framework, tagName, adapter, handle, mounted: false }
      entries.set(framework, entry)
      if (root) {
        adapter.mountContainer(handle, root)
        entry.mounted = true
      }
      inflight.delete(framework)
      return entry
    })
    task.catch(() => inflight.delete(framework))
    inflight.set(framework, task)
    return task
  }

  return {
    setRoot(next) {
      root = next
      for (const entry of entries.values()) {
        if (entry.mounted) continue
        entry.adapter.mountContainer(entry.handle, next)
        entry.mounted = true
      }
    },
    ensure(framework) {
      const existing = entries.get(framework)
      if (existing) return Promise.resolve(existing)
      return inflight.get(framework) ?? create(framework)
    },
    get(framework) {
      return entries.get(framework)
    },
    patch(framework, view) {
      const entry = entries.get(framework)
      if (!entry) return
      entry.adapter.patchContainer(entry.handle, view)
    },
    deactivateOthers(active, stylesVersion) {
      for (const [framework, entry] of [...entries]) {
        if (framework === active) continue
        if (strategy === 'unmount') {
          entry.adapter.unmountContainer(entry.handle)
          entries.delete(framework)
        } else {
          entry.adapter.patchContainer(entry.handle, EMPTY_VIEW(framework, stylesVersion))
        }
      }
    },
    dispose() {
      for (const entry of entries.values()) {
        entry.adapter.unmountContainer(entry.handle)
        entry.adapter.dispose?.()
      }
      entries.clear()
      inflight.clear()
      root = null
    },
  }
}
