// 宿主 store → CE 的镜像端（CE 侧）。
//
// 把 state 桥里的 `store:<id>` 快照 hydrate 进**本批 pinia 的同名 store**：
// 页面代码零改动（`const auth = useAuthStore(); auth.token` 照旧），数据由宿主推来。
//
// 与「共用同一个 pinia 实例」的区别：这是**同一份数据、两个 store 对象**（镜像）。
// 跨副本共享实例不可行的原因见 hostStore.ts 顶部注释。
//
// 边界（也写进 docs/INTEGRATION_GUIDE.md）：
// - 只同步可序列化 `$state`：getter（computed）不在 `$state` 里，CE 侧请自行派生；
// - action 不过桥：页面调宿主 action 请走 `context.emit(...)`；
// - 对象身份不相等：`ceStore.user !== hostStore.user`。
//
// 容器入口用法（每个批次一次）：
// ```ts
// const mirror = createStoreMirror()
// export default defineVueContainer({
//   plugins: [createPinia().use(mirror.plugin), ElementPlus],
//   setup: (context) => mirror.attach(context),
// })
// ```
import { shallowRef, watch } from 'vue'
import { cloneHostState, hostStoreKey, STORE_PATCH_EVENT, type HostStoreLike } from './hostStore.js'

/** 镜像只需要容器 context 的这两件事（`RuntimeServicesContext` 天然满足） */
export interface StoreMirrorContext {
  /** 容器侧的浅响应式副本（`RuntimeServicesContext.state`） */
  readonly state: Record<string, unknown>
  emit?(event: string, payload?: unknown): void
}

export interface StoreMirrorOptions {
  /** 只镜像这些 store id（缺省全部） */
  only?: readonly string[]
  /**
   * 打开后：CE 侧 store 变更会 `context.emit('store-patch', { id, patch })` 回传宿主。
   * 缺省关（宿主是唯一真相源，避免双向回环）。宿主侧处理见 `applyHostStorePatch`。
   */
  twoWay?: boolean
}

export interface StoreMirror {
  /** 交给 `createPinia().use(mirror.plugin)` */
  plugin: (context: { store: HostStoreLike }) => void
  /** 在容器 `setup(context)` 里调用一次 */
  attach(context: StoreMirrorContext): void
  /** 解绑所有 watch / 订阅（store 自身的 $dispose 也会自动解绑） */
  dispose(): void
}

export function createStoreMirror(options: StoreMirrorOptions = {}): StoreMirror {
  const only = options.only ? new Set(options.only) : null
  const stops = new Set<() => void>()
  /** 已挂钩的 store → state key（attach 晚于 store 创建时用来补 hydrate） */
  const hooked = new Map<HostStoreLike, string>()
  // 用 shallowRef 而不是普通变量：插件的 watch 依赖里必须包含「context 就绪」这件事，
  // 否则 store 先于 attach 创建时（getter 里 context 为 null，什么都没读到）watcher 会永远不再触发。
  const contextRef = shallowRef<StoreMirrorContext | null>(null)

  const snapshotOf = (key: string): unknown => contextRef.value?.state[key]

  const hydrate = (store: HostStoreLike, snapshot: unknown): void => {
    if (!snapshot || typeof snapshot !== 'object') return
    // 再克隆一次：否则 CE 的 store 与宿主快照共享嵌套引用，
    // 宿主原地改嵌套字段时页面「读得到新值但不重渲染」。
    store.$patch(cloneHostState(snapshot) as Record<string, unknown>)
  }

  const plugin = ({ store }: { store: HostStoreLike }): void => {
    if (only && !only.has(store.$id)) return
    if (hooked.has(store)) return
    const key = hostStoreKey(store.$id)
    hooked.set(store, key)
    // 首次：宿主可能已经推过（页面 store 建得比宿主数据晚）
    hydrate(store, snapshotOf(key))
    // 后续：容器把新快照写进浅响应式副本 → watch 触发。
    // 非 deep 是有意的：宿主每次推的都是**新对象**（见 cloneHostState），
    // 嵌套原地改动本来就不会被 state 桥通知（Object.is 判等）。
    const stopWatch = watch(
      () => contextRef.value?.state[key],
      (snapshot) => hydrate(store, snapshot),
    )
    stops.add(stopWatch)

    if (options.twoWay) {
      const stopSubscribe = store.$subscribe(() => {
        contextRef.value?.emit?.(STORE_PATCH_EVENT, { id: store.$id, patch: cloneHostState(store.$state) })
      })
      stops.add(stopSubscribe)
    }

    // pinia 不会替插件清理副作用：store 销毁时自己解绑
    const originalDispose = typeof store.$dispose === 'function' ? store.$dispose.bind(store) : null
    if (originalDispose) {
      store.$dispose = () => {
        stopWatch()
        hooked.delete(store)
        originalDispose()
      }
    }
  }

  return {
    plugin,
    attach(next) {
      contextRef.value = next
      // 挂钩时还没有 context（或宿主数据还没到）的 store：补一次 hydrate
      for (const [store, key] of hooked) hydrate(store, next.state[key])
    },
    dispose() {
      for (const stop of stops) stop()
      stops.clear()
      hooked.clear()
      contextRef.value = null
    },
  }
}
