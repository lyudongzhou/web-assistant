// 宿主直连 runtime（用法 B 的门面）—— 宿主项目用这一个函数即可把 agent 接到自己的真实路由上。
//
// 典型用法（宿主 main.ts / App.vue）：
// ```ts
// import { createVueHostRuntime } from '@webassistant/wc-runtime-vue/host-router'
//
// const makeRuntime = ({ initial }) => createVueHostRuntime({
//   router,                                            // 宿主真实 vue-router
//   app,                                               // 可选：provide runtime context 给页面
//   manifestUrl: '/wc/manifest.json',
//   observeNetwork: true,                              // 零侵入让 agent 看到接口数据
//   initial,
// })
// ```
// 语义要点：
//   - 页面在宿主自己的 <router-view> 渲染，不进容器、不编译 WC
//   - 页面目录（manifest）的 name 必须等于宿主 route 的 name（init 时校验，缺失一次性报错）
//   - 首屏默认 adopt 宿主当前路由（`adopt: false` 可关），因此不需要 initialPage
//   - 只在一个位置挂载（apiBus / 网络观测是全局副作用）
import { createRuntime, type CreateRuntimeOptions, type Runtime } from '@webassistant/wc-runtime-core'
import type { App } from 'vue'
import type { Router } from 'vue-router'
import { createVueHostSurface } from './hostSurface.js'

export interface CreateVueHostRuntimeOptions
  extends Omit<CreateRuntimeOptions, 'surface' | 'hostSurface' | 'adapters'> {
  /** 宿主真实 vue-router（web / hash 历史都行） */
  router: Router
  /** 宿主 app：给了就能把 runtime context provide 给页面（`useRuntimeServices()` 可用） */
  app?: App
  /** 是否把直传 props 走旁路下发（缺省 true） */
  passProps?: boolean
}

/** 当前活跃的 host runtime 数（apiBus / NetworkObserver 是全局副作用 → 不允许并存） */
let activeHostRuntimes = 0

export function createVueHostRuntime(options: CreateVueHostRuntimeOptions): Runtime {
  const { router, app, passProps, ...rest } = options

  if (activeHostRuntimes > 0) {
    console.warn(
      '[wc-runtime-vue] 检测到第二个 host 模式 runtime：数据上报（apiBus）与网络观测是全局副作用，' +
        '多实例会互相抢占。请只在布局外壳里挂载一处 <WebAssistant>（不要挂在路由组件内）。',
    )
  }
  activeHostRuntimes += 1

  const runtime = createRuntime({
    ...rest,
    surface: 'host',
    hostSurface: createVueHostSurface({ router, app, passProps }),
    // 首屏语义由内核统一：host 模式不传 initial 时不自动打开任何页面（页面由宿主 URL 决定），
    // 只靠 adopt 把宿主当前路由纳入内核
    adopt: rest.adopt ?? true,
  })

  // 记账：dispose 时把活跃计数还回去（Runtime 是带 getter 的对象，不能简单展开复制）
  const originalDispose = runtime.dispose.bind(runtime)
  let released = false
  Object.defineProperty(runtime, 'dispose', {
    configurable: true,
    writable: true,
    value: () => {
      if (!released) {
        released = true
        activeHostRuntimes = Math.max(0, activeHostRuntimes - 1)
      }
      originalDispose()
    },
  })

  return runtime
}
