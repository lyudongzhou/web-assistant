// @webassistant/wc-runtime-core
// 定义层：契约类型 + 框架无关实现。宿主不直接依赖本包，请使用 @webassistant/wc-runtime-vue。
export * from './types.js'
export { createRuntime } from './runtime.js'
export type {
  KernelHandles,
  PageSurface,
  RuntimeHistory,
  SurfaceRenderContext,
} from './surface.js'
export { normalizeManifest, extractParams, type NormalizeOptions } from './manifest.js'
export {
  createNavigationController,
  fillPath,
  parseParams,
  type NavigationController,
} from './navigation.js'
export { createBundleLoader, fetchText, type BundleLoader } from './loader.js'
export {
  createContainerManager,
  type ContainerEntry,
  type ContainerManager,
  type ContainerManagerOptions,
} from './containers.js'
export { createStyleRegistry, type StyleLayer, type StyleRegistry } from './styles.js'
export { coerceValue, resolveProps, type ResolvePropsInput } from './props.js'
export { createServicesRef, looksFrameworkBound, type MutableServicesRef } from './services.js'
export { createStateBridge, type StateBridge, type StatePatch } from './state.js'
export { createEventBus, type EventBus } from './events.js'
export { sanitizeData } from './sanitize.js'
export { apiBus, type ApiReport } from './apiBus.js'
export {
  activityBus,
  currentActivityOrigin,
  isActivityTraced,
  markActivityTraced,
  withActivityOrigin,
  type ActivityBus,
  type WcActivity,
  type WcActivityInput,
  type WcActivityKind,
  type WcActivityOrigin,
} from './activity.js'
export {
  matchDataSource,
  summarizeData,
} from './dataSources.js'
export {
  adoptSheets,
  applyThemeVars,
  createSharedSheet,
  hashString,
  injectLightDomStyles,
  injectLightDomStylesBulk,
  joinUrl,
  resetLightDomStyles,
  rewriteRootToHost,
} from './dom.js'
export {
  addStyleTarget,
  bindProxy,
  currentStyleTargets,
  installStyleSink,
  removeStyleTarget,
  resetStyleSink,
  shadowDocument,
  beginStyleScope,
  endStyleScope,
  activateStyleScope,
  clearStyleScopes,
  STYLE_SINK_API_GLOBAL,
  STYLE_SINK_API_KEY,
  STYLE_SINK_GLOBAL,
  DEFAULT_STYLE_SCOPE,
  type StyleSinkApi,
} from './styleSink.js'
