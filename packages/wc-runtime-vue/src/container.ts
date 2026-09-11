// Vue 容器：<runtime-vue> —— 唯一样式隔离边界 + 公共依赖/服务的注入点。
//
// 「runtime 自有依赖」（vue / vue-router / element-plus…）随本容器所在的批次构建进 bundle，
// 与页面 WC 共享同一份 chunk（同一次构建的产物用相对 URL 互相 import，浏览器按 URL 去重）。
// 「外层传入依赖」（request / t / token / state…）由宿主经 servicesRef 注入，容器 provide 给页面。
import { defineCustomElement, h, shallowReactive, type App, type VNode } from 'vue'
import type { Router } from 'vue-router'
import {
  activityBus,
  addStyleTarget,
  adoptSheets,
  applyThemeVars,
  createSharedSheet,
  currentActivityOrigin,
  injectLightDomStyles,
  injectLightDomStylesBulk,
  markActivityTraced,
  removeStyleTarget,
  rewriteRootToHost,
  type DefineContainerOptions,
  type PageModule,
  type RouterBridgeApi,
  type RuntimeAdapter,
  type RuntimeErrorInfo,
  type RuntimeView,
  type WcActivityOrigin,
} from '@webassistant/wc-runtime-core'
import { createRuntimeContext, provideRuntimeContext, type RuntimeServicesContext } from './context.js'
import { createVueRouter, createVueRouterBridge } from './vueRouterBridge.js'
import type { VuePageApi, VuePlugin } from './definePage.js'

export interface VueContainerOptions {
  /** 容器标签名，缺省 runtime-vue（manifest 里声明的优先） */
  tagName?: string
  /** 每个页面 app 都会 app.use：element-plus / pinia / 自定义插件 */
  plugins?: VuePlugin[]
  /** 注入容器 shadow root 的样式（UI 库 CSS）；:root 会自动重写为 :host */
  shadowStyles?: string[]
  /** 注入光 DOM 的样式：UI 库浮层 teleport 到 body 时用（隔离方案的已知泄漏点） */
  lightDomStyles?: string[]
  /** 是否为页面提供容器内建的 vue-router（默认 true） */
  useVueRouter?: boolean
  /** 额外 provide 给页面（symbol / 字符串键） */
  provides?: Record<string | symbol, unknown>
  /**
   * 一次性初始化钩子（每个容器实例只调一次，早于任何页面注册）。
   * 用来配置批次内的共享单例：axios 拦截器 / dayjs locale / echarts 主题 —— 拿到的 context
   * 是稳定引用，内部读 context.services.xxx 永远是最新值。
   */
  setup?: (context: RuntimeServicesContext) => void
  /** 自定义空态 / 加载态 / 错误态 */
  renderEmpty?: () => VNode | VNode[]
  renderLoading?: (view: ContainerViewProps) => VNode | VNode[]
  renderError?: (error: RuntimeErrorInfo) => VNode | VNode[]
  /** 容器 app 与页面 app 的公共配置钩子 */
  configureApp?: (app: App, api: { context: RuntimeServicesContext; router?: Router }) => void
}

export interface ContainerViewProps {
  tag?: string | null
  pageProps?: Record<string, unknown>
  pageStyles?: string[]
  stylesVersion?: number
  status?: RuntimeView['status']
  error?: RuntimeErrorInfo | null
  events?: string[]
}

export interface VueContainerHandle {
  element: HTMLElement & ContainerViewProps
  tagName: string
  /**
   * 当前页面元素实例（Vue CE 自定义元素）的引用缓存。
   * 在 patchContainer 后由 Vue 渲染完成时填充；getPageExposed 据此取 .exposed。
   */
  currentPageElement?: HTMLElement | null
}

const toPascal = (name: string): string =>
  name.replace(/(^|[-_])([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())

/** 记录每个容器标签是由哪个 adapter 实例注册的 —— 自定义元素不可注销，重复注册只能告警 */
const registeredBy = new Map<string, symbol>()

/** 把 props 全部以 `.` 前缀下发，强制走 DOM property —— 对象/数组不能经 attribute 传递 */
function toElementProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) out[`.${key}`] = value
  return out
}
// ---------------------------------------------------------------- expose 调用监视
//
// 这里把 `defineExpose` 的每个函数字段包一层 Proxy，用 activityBus 记录「谁在什么时候调了哪个方法、
// 传了什么、返回什么 / 耗时多久」。落在这里的原因是：`runtime.getPageExposed()` 是**所有**外部调用者的
// 唯一入口（agent 的 call_page_method、宿主代码直调、调试脚本都走它）。
// 已知盲区：页面内部用闭包直接调自己的函数、用户点按钮触发的页面内部 handler —— 不经 exposed 对象，看不见。
// 用 Proxy（而非包装函数）是为了保持透明：`typeof`、`new`、`name`/`length`、`this` 都原样透传。
function traceExposed(tag: string, exposed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(exposed)) {
    out[name] = typeof value === 'function' ? traceMethod(tag, name, value as (...args: unknown[]) => unknown) : value
  }
  return out
}

function traceMethod(tag: string, name: string, fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  const record = (
    origin: WcActivityOrigin,
    startedAt: number,
    args: unknown[],
    outcome: { ok: true; result?: unknown } | { ok: false; error: string },
  ): void => {
    activityBus.report({
      kind: 'call',
      tag,
      name,
      args: args.length ? args : undefined,
      origin,
      ok: outcome.ok,
      durationMs: Date.now() - startedAt,
      ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
    })
  }
  const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

  const traced = new Proxy(fn, {
    apply(target, thisArg, args: unknown[]) {
      const startedAt = Date.now()
      // origin 必须在「调用发生的那一刻」取：async 方法的结算在之后的 microtask，
      // 那时 withActivityOrigin 的同步区间早已退出。
      const origin = currentActivityOrigin()
      let result: unknown
      try {
        result = Reflect.apply(target, thisArg, args)
      } catch (cause) {
        record(origin, startedAt, args, { ok: false, error: describe(cause) })
        throw cause
      }
      // async 方法：等 Promise 结算再记录（不吞异常，原样往下传）
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        return (result as Promise<unknown>).then(
          (value) => {
            record(origin, startedAt, args, { ok: true, result: value })
            return value
          },
          (cause) => {
            record(origin, startedAt, args, { ok: false, error: describe(cause) })
            throw cause
          },
        )
      }
      record(origin, startedAt, args, { ok: true, result })
      return result
    },
  })
  // 打标：宿主（callPageMethod）据此知道这次调用已被自动记账，不再重复上报
  return markActivityTraced(traced)
}



/**
 * 定义一个 Vue 批次的容器，返回 core 可用的 adapter。
 * 批次入口（wc.pages.json 的 container）标准写法：
 * ```ts
 * import { defineVueContainer } from '@webassistant/wc-runtime-vue'
 * import ElementPlus from 'element-plus'
 * import epCss from 'element-plus/dist/index.css?inline'
 * import { createPinia } from 'pinia'
 * export default defineVueContainer({
 *   plugins: [ElementPlus, createPinia()],
 *   shadowStyles: [epCss],
 *   lightDomStyles: [epCss],
 * })
 * ```
 */
export function defineVueContainer(
  options: VueContainerOptions = {},
): RuntimeAdapter<VueContainerHandle> {
  const useVueRouter = options.useVueRouter !== false
  const identity = Symbol('wa-vue-container')
  let router: Router | undefined
  let context: RuntimeServicesContext | undefined
  let reportPageEvent: DefineContainerOptions['onPageEvent']
  let setupDone = false
  /** 本实例挂载过的 shadow root（dispose 时统一注销样式落点） */
  const styleTargets: ShadowRoot[] = []

  const shadowCss = (options.shadowStyles ?? []).map(rewriteRootToHost)
  const sharedSheets = shadowCss
    .map(createSharedSheet)
    .filter((sheet): sheet is CSSStyleSheet => Boolean(sheet))

  /** 页面 emit → CustomEvent（Vue CE 默认 composed:false，停在容器 shadow root 内）→ page-event */
  function buildListeners(props: ContainerViewProps): Record<string, unknown> {
    if (!reportPageEvent || !props.tag) return {}
    const listeners: Record<string, unknown> = {}
    for (const event of props.events ?? []) {
      listeners[`on${toPascal(event)}`] = (payload: CustomEvent) => {
        reportPageEvent?.({ tag: props.tag as string, event, payload: payload?.detail ?? payload })
      }
    }
    return listeners
  }

  function renderContent(props: ContainerViewProps): VNode {
    if (props.status === 'error' && props.error) {
      const custom = options.renderError?.(props.error)
      return h('div', { class: 'wa-runtime-error' }, (custom as VNode[]) ?? props.error.message)
    }
    if (!props.tag) {
      const custom = options.renderEmpty?.()
      return h('div', { class: 'wa-runtime-empty' }, (custom as VNode[]) ?? '暂无页面')
    }
    if (props.status === 'loading') {
      const custom = options.renderLoading?.(props)
      return h('div', { class: 'wa-runtime-loading' }, (custom as VNode[]) ?? '加载中…')
    }
    return h(props.tag, { ...toElementProps(props.pageProps ?? {}), ...buildListeners(props) })
  }

  function buildComponent(define: DefineContainerOptions) {
    const state = shallowReactive<Record<string, unknown>>({ ...define.servicesRef.state })
    define.servicesRef.subscribe((ref, change) => {
      if (change.kind !== 'state') return
      for (const key of change.keys) state[key] = ref.state[key]
    })
    context = createRuntimeContext(define.servicesRef, define.navigation, state, define.observer)
    if (useVueRouter && !router) router = createVueRouter()
    if (!setupDone) {
      setupDone = true
      options.setup?.(context)
    }

    return {
      props: {
        tag: { type: String, default: '' },
        pageProps: { type: Object, default: () => ({}) },
        pageStyles: { type: Array, default: () => [] },
        stylesVersion: { type: Number, default: 0 },
        status: { type: String, default: 'idle' },
        error: { type: Object, default: null },
        events: { type: Array, default: () => [] },
      },
      setup(props: ContainerViewProps) {
        return () => {
          const nodes: VNode[] = []
          // adoptedStyleSheets 可用时共享同一份 CSSStyleSheet（跨容器只解析一次），否则回退 <style>
          if (!sharedSheets.length) nodes.push(...shadowCss.map((css) => h('style', css)))
          nodes.push(...(props.pageStyles ?? []).map((css) => h('style', css as string)))
          nodes.push(renderContent(props))
          return h('div', { class: 'wa-runtime-host', 'data-status': props.status }, nodes)
        }
      },
    }
  }

  return {
    framework: 'vue',
    defaultTagName: options.tagName ?? 'runtime-vue',

    defineContainer(define) {
      reportPageEvent = define.onPageEvent
      for (const [index, css] of (options.lightDomStyles ?? []).entries()) {
        injectLightDomStyles(css, `${define.tagName}-${index}`)
      }
      if (!customElements.get(define.tagName)) {
        const Element = defineCustomElement(buildComponent(define) as never, {
          configureApp: (app: App) => {
            if (router) app.use(router)
            provideRuntimeContext(app, context!)
            for (const [key, value] of Object.entries(options.provides ?? {})) {
              app.provide(key, value)
            }
            options.configureApp?.(app, { context: context!, router })
          },
        })
        customElements.define(define.tagName, Element)
        registeredBy.set(define.tagName, identity)
      } else {
        // 自定义元素不可注销：同名标签只能沿用先注册的那份定义（含它的 context / router）
        if (registeredBy.get(define.tagName) !== identity) {
          console.warn(
            `[wc-runtime-vue] <${define.tagName}> 已被另一个容器实例注册。自定义元素无法重新定义，` +
              '本次的 services / router 不会生效。请给每个 runtime 实例用不同的 tagName。',
          )
        }
        if (!context) buildComponent(define)
      }

      const element = document.createElement(define.tagName) as VueContainerHandle['element']
      applyThemeVars(element, define.servicesRef.current.theme ?? {})
      define.servicesRef.subscribe((ref, change) => {
        if (change.kind === 'services' && change.keys.includes('theme')) {
          applyThemeVars(element, ref.current.theme ?? {})
        }
      })
      return { element, tagName: define.tagName }
    },

    mountContainer(handle, root) {
      root.appendChild(handle.element)
      const shadow = handle.element.shadowRoot
      if (shadow && sharedSheets.length) adoptSheets(shadow, sharedSheets)
      // 登记为「样式收件人」：被 styleShim 遮蔽的依赖往 document 注入的 <style>
      // 会镜像一份到容器的 shadow root 里（详见 wc-runtime-core/styleSink.ts）
      if (shadow) {
        styleTargets.push(shadow)
        addStyleTarget(shadow)
      }
    },

    patchContainer(handle: VueContainerHandle, view: RuntimeView) {
      const el = handle.element
      el.tag = view.tag ?? ''
      el.pageProps = view.props
      el.pageStyles = [...view.styles]
      // 页面/共享组件样式默认进 shadow root；但浮层（el-dialog / select 下拉 / tooltip）teleport 到 body
      // 会跑出 shadow 边界，必须把这些样式也补一份到光 DOM（内容哈希去重、append-only）。
      injectLightDomStylesBulk(view.styles, 'wa-page')
      el.stylesVersion = view.stylesVersion
      el.status = view.status
      el.error = view.error ?? null
      el.events = [...view.events]
      // 等待 Vue 完成本帧 patch 后再查 shadow DOM 里的页面 CE 元素。
      // 用 rAF 兜底 setTimeout：与浏览器渲染节奏对齐，最坏也只在下一帧前就位。
      const tag = view.tag
      if (!tag) {
        handle.currentPageElement = null
        return
      }
      const capture = () => {
        const shadow = el.shadowRoot
        handle.currentPageElement = (shadow ? shadow.querySelector(tag) : null) as HTMLElement | null
      }
      // 已挂载过的 tag：Vue 的 CE 是首次出现后才实例化，未必在 shadow DOM 里。
      // querySelector(null) 容错由 capture 内部处理。
      queueMicrotask(() => {
        capture()
        if (!handle.currentPageElement && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(capture)
        }
      })
    },

    getPageExposed(handle: VueContainerHandle, tag?: string): Record<string, unknown> | null {
      const el = handle.element
      // tag 不传 → 当前页：直接读缓存的 element
      // tag 传了 → 指定页：尝试从 shadow DOM 里按 tag 名查
      let target: HTMLElement | null = null
      if (!tag || tag === el.tag) {
        target = handle.currentPageElement ?? null
      } else {
        const shadow = el.shadowRoot
        target = (shadow ? shadow.querySelector(tag) : null) as HTMLElement | null
      }
      if (!target) return null
      // Vue defineCustomElement 挂 expose 的位置随版本有差异（3.5.41 实测）：
      // - defineExpose 的原始对象在组件实例上：element._instance.exposed
      // - Vue 3.5 同时把 exposed 成员拷成元素自身的 property（page.refresh 可直接调），
      //   但**没有** element.exposed 这个属性 —— 旧实现只读 .exposed 会拿到 undefined。
      // 两条路都试，都没有才返回 null（旧版本 Vue / 页面没写 defineExpose）。
      const host = target as HTMLElement & {
        exposed?: Record<string, unknown>
        _instance?: { exposed?: Record<string, unknown> } | null
      }
      const exposed = host.exposed ?? host._instance?.exposed
      if (!exposed || typeof exposed !== 'object') return null
      return traceExposed(tag ?? el.tag ?? '', exposed)
    },

    unmountContainer(handle) {
      const shadow = handle.element.shadowRoot
      if (shadow) {
        const index = styleTargets.indexOf(shadow)
        if (index >= 0) styleTargets.splice(index, 1)
        removeStyleTarget(shadow)
      }
      handle.element.remove()
    },

    definePage(mod: PageModule, api) {
      const register = mod.definePage ?? (typeof mod.default === 'function' ? mod.default : null)
      if (typeof register !== 'function') {
        throw new Error(`页面 bundle（${api.route.bundle}）需导出 definePage(api) 或默认导出该函数`)
      }
      const vueApi: VuePageApi = {
        ...api,
        plugins: options.plugins,
        router,
        context: context!,
        provides: options.provides,
        configureApp: options.configureApp
          ? (app) => options.configureApp!(app, { context: context!, router })
          : undefined,
      }
      register(vueApi)
    },

    createRouterBridge(api: RouterBridgeApi) {
      if (!useVueRouter) {
        return { apply: () => undefined, setRoutes: () => undefined, dispose: () => undefined }
      }
      if (!router) router = createVueRouter(api.routes)
      return createVueRouterBridge(router, api)
    },

    dispose() {
      for (const target of styleTargets.splice(0)) removeStyleTarget(target)
      context = undefined
    },
  }
}

export default defineVueContainer

