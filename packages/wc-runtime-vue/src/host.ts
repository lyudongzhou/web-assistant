// 宿主侧入口：只做编排，**不引入 vue / vue-router / 容器实现**。
// 容器与页面都是从 manifest 声明的 bundle（dist-ce）动态加载的，宿主没必要把那份实现打进自己的产物。
//
// import { createHostRuntime } from '@webassistant/wc-runtime-vue/host'
export { createRuntime as createHostRuntime } from '@webassistant/wc-runtime-core'

export type {
  ContainerStrategy,
  CreateRuntimeOptions as CreateHostRuntimeOptions,
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
  RuntimeView,
  Unsubscribe,
} from '@webassistant/wc-runtime-core'

export type { PageEventPayload } from '@webassistant/protocol'
export type { NetworkObservation, NetworkObserver } from '@webassistant/wc-runtime-core'

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
