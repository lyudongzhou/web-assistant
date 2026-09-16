// 宿主侧入口：只做编排，**不引入 vue / vue-router / 容器实现**。
// 容器与页面都是从 manifest 声明的 bundle（dist-ce）动态加载的，宿主没必要把那份实现打进自己的产物。
//
// import { createHostRuntime } from '@webassistant/wc-runtime-vue/host'
export { createRuntime as createHostRuntime } from '@webassistant/wc-runtime-core'

export type {
  ContainerStrategy,
  CreateRuntimeOptions as CreateHostRuntimeOptions,
  HostSurface,
  HostSurfaceRuntimeApi,
  NavigationResult,
  NavigationSource,
  NavigationTarget,
  Runtime,
  RuntimeErrorInfo,
  RuntimeEventMap,
  RuntimeEventName,
  RuntimeLocation,
  RuntimeManifestInput,
  RuntimeNavApi,
  RuntimeRoute,
  RuntimeServices,
  RuntimeStatus,
  RuntimeSurfaceKind,
  RuntimeView,
  Unsubscribe,
} from '@webassistant/wc-runtime-core'

export type { PageEventPayload } from '@webassistant/protocol'
export { apiBus, type ApiReport } from '@webassistant/wc-runtime-core'

// 宿主 store → CE 的快照桥（宿主侧）。**不引入 vue / pinia**：宿主只在需要时用，
// 不会因为 import 本入口就把 vue 打进自己的产物。
export {
  HOST_STORE_KEY_PREFIX,
  STORE_PATCH_EVENT,
  applyHostStorePatch,
  cloneHostState,
  createHostStorePusher,
  hostStoreIdFromKey,
  hostStoreKey,
  isHostStoreKey,
} from './hostStore.js'
export type { HostPiniaLike, HostRuntimeLike, HostStoreLike, StorePusher } from './hostStore.js'

// 「WC 执行监视」：activityBus 是全局单例（Symbol.for + globalThis），
// 容器 bundle 里的上报与宿主这里的订阅拿到的是同一份状态，因此宿主可以直接读/订阅。
export {
  activityBus,
  currentActivityOrigin,
  isActivityTraced,
  markActivityTraced,
  withActivityOrigin,
} from '@webassistant/wc-runtime-core'
export type {
  ActivityBus,
  WcActivity,
  WcActivityInput,
  WcActivityKind,
  WcActivityOrigin,
} from '@webassistant/wc-runtime-core'
