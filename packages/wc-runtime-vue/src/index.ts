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
export {
  createVueRouter,
  createVueRouterBridge,
  toRouteRecords,
  type VueRouterBridge,
} from './vueRouterBridge.js'

// 转出宿主会用到的 core 契约类型，让宿主无需直接依赖 core
export type {
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
  RuntimeView,
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
