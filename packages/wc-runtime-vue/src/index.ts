// @webassistant/wc-runtime-vue
// 由 wc-runtime-core 衍生的 Vue 实现，也是唯一对外门面：宿主与批次入口都只 import 本包。
import { createRuntime, type CreateRuntimeOptions, type Runtime } from '@webassistant/wc-runtime-core'
import { defineVueContainer, type VueContainerHandle, type VueContainerOptions } from './container.js'

export { defineVueContainer } from './container.js'
export type {
  ContainerViewProps,
  VueContainerHandle,
  VueContainerOptions,
} from './container.js'
export { definePage } from './definePage.js'
export type { VuePageApi, VuePlugin } from './definePage.js'
export {
  createRuntimeContext,
  provideRuntimeContext,
  useRuntimeServices,
  tryUseRuntimeServices,
  RUNTIME_CONTEXT_KEY,
} from './context.js'
export type { RuntimeServicesContext } from './context.js'
export { apiBus, type ApiReport } from '@webassistant/wc-runtime-core'
// 宿主 store → CE 的快照桥：宿主侧推手（零 vue 依赖）+ CE 侧镜像（pinia 插件）
export {
  HOST_STORE_KEY_PREFIX,
  STORE_PATCH_EVENT,
  applyHostStorePatch,
  cloneHostState,
  createHostStorePusher,
  hostStoreIdFromKey,
  hostStoreKey,
  isHostStoreKey,
  type HostPiniaLike,
  type HostRuntimeLike,
  type HostStoreLike,
  type StorePusher,
} from './hostStore.js'
export {
  createStoreMirror,
  type StoreMirror,
  type StoreMirrorContext,
  type StoreMirrorOptions,
} from './storeMirror.js'
export {
  createVueRouter,
  createVueRouterBridge,
  toRouteRecords,
  type VueRouterBridge,
} from './vueRouterBridge.js'
export {
  createRouterSync,
  defaultApplyLocation,
  toNavigationTarget,
  type RouterSyncOptions,
  type VueRouterSync,
} from './routerSync.js'
// 宿主直连用法（用法 B）：agent 操作宿主真实 router，页面在宿主自己的 <router-view> 渲染。
// 只想用这一条用法时走子入口 `@webassistant/wc-runtime-vue/host-router`（不引入容器 / CE 机制）。
export { createVueHostSurface, type VueHostSurface, type VueHostSurfaceOptions } from './hostSurface.js'
export { createVueHostRuntime, type CreateVueHostRuntimeOptions } from './hostRouter.js'

// 转出宿主会用到的 core 契约类型，让宿主无需直接依赖 core
export type {
  HostSurface,
  HostSurfaceRuntimeApi,
  NavigationResult,
  NavigationTarget,
  Runtime,
  RuntimeErrorInfo,
  RuntimeEventMap,
  RuntimeLocation,
  RuntimeManifestInput,
  RuntimeNavApi,
  RuntimeRoute,
  RuntimeServices,
  RuntimeStatus,
  RuntimeSurfaceKind,
  RuntimeView,
  SurfaceRenderContext,
} from '@webassistant/wc-runtime-core'

export interface CreateVueRuntimeOptions extends Omit<CreateRuntimeOptions, 'adapters'> {
  /**
   * 本地容器配置。传了就用「预注册 adapter」模式（不加载容器 bundle），
   * 适合宿主与页面同构建、或本地开发/测试；生产走 manifest.containers 的容器 bundle。
   */
  container?: VueContainerOptions
  /** 追加其它框架的 adapter（如未来的 react 容器） */
  adapters?: CreateRuntimeOptions['adapters']
}

/**
 * 宿主入口：
 * ```ts
 * const rt = createVueRuntime({ manifestUrl: '/wc/manifest.json', assetBase: '/wc/dist-ce',
 *   services: { request, t, getToken, theme, emit } })
 * await rt.init(mountEl)
 * await rt.navigate({ tag: 'user-list', source: 'agent' })
 * ```
 */
export function createVueRuntime(options: CreateVueRuntimeOptions = {}): Runtime {
  const { container, adapters = [], ...rest } = options
  const locals = container ? [defineVueContainer(container) as never] : []
  return createRuntime({ ...rest, adapters: [...locals, ...adapters] })
}

export type { VueContainerHandle as VueHandle }
