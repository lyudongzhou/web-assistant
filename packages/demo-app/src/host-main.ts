// 用法 B 验收台（宿主直连）入口：宿主自己的 SPA（vue-router + <router-view>）+ 悬浮对话面板。
//
// 与既有两条链路的关系：
//   src/main.ts        → SPA 模式（`pnpm dev`，验证页面功能）
//   vite.ce.config.ts  → WC 模式（`pnpm build:ce` + `pnpm preview:ce`，验证容器渲染）
//   本文件              → 用法 B：agent 直接操作宿主真实 router，页面在宿主自己的 <router-view> 渲染
//
// 关键约束：面板挂在 <router-view> **之外**（这里是 fixed 悬浮层）。挂在路由组件里的话，
// agent 一导航面板自身就被卸载 → 对话中断。
import { createApp, h, ref } from 'vue'
import { RouterLink, RouterView, createRouter, createWebHashHistory, type RouteLocationRaw } from 'vue-router'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './ce/tailwind.css'
import { createVueHostRuntime } from '@webassistant/wc-runtime-vue/host-router'
import { WebAssistant } from '@webassistant/chat-client'
import { routes } from './router'

const router = createRouter({ history: createWebHashHistory(), routes })

/** 导航只放「不需要必填参数」的路由；带参数的路由另行给一个样例链接（:id 缺参会直接抛错） */
const navRoutes = routes.filter((route) => route.name && !route.path.includes(':'))
const detailRoute = routes.find((route) => route.path.includes(':'))

const app = createApp({
  setup() {
    const open = ref(true)
    const link = (to: RouteLocationRaw, label: string) =>
      h(RouterLink, { to }, { default: () => label })
    return () =>
      h('div', { class: 'host-shell' }, [
        // ① 宿主自己的导航（点它就等于「用户自己操作路由」→ 回流内核，source: 'host'）
        h('header', { class: 'host-nav' }, [
          h('strong', '宿主应用（用法 B 验收台）'),
          ...navRoutes.map((route) =>
            link(
              { name: route.name },
              (route.meta as { title?: string } | undefined)?.title ?? String(route.name),
            ),
          ),
          // 带参数路由：给一个样例（用户点它 → 内核收到 source: 'host' 的导航）
          detailRoute
            ? link({ name: detailRoute.name, params: { id: '1' } }, '用户详情 #1')
            : null,
        ]),
        // ② 页面：原样渲染在宿主自己的 router-view
        h('main', { class: 'host-body' }, [h(RouterView)]),
        // ③ 对话面板（悬浮层，不随路由切换消失）
        h('div', { class: 'wa-dock' }, [
          h(
            'button',
            { class: 'wa-toggle', onClick: () => (open.value = !open.value) },
            open.value ? '收起助手' : '打开助手',
          ),
          open.value
            ? h(WebAssistant, {
                surface: 'host',
                wsBase: '/ws',
                title: 'Web Assistant（宿主直连）',
                subtitle: 'agent 直接操作宿主 router',
                placeholder: '描述你想打开的页面…',
                showActivityLog: true,
                debug: true,
                // ★ host 模式的 runtime 由宿主构造（chat-client 不依赖 vue-router）
                createRuntime: ({ initial }) =>
                  createVueHostRuntime({
                    router,
                    app, // 给了才能把 runtime context provide 进宿主 app（页面可用 useRuntimeServices）
                    manifestUrl: '/wc/manifest.json',
                    // 零侵入让 agent 看到页面接口数据（host 模式下与页面同副本，最准）
                    observeNetwork: true,
                    services: {
                      // host 模式下页面本来就能用宿主自己的 http / store / i18n，
                      // services 只用于「宿主主动补给 runtime」的通道（这里演示数据上报）
                      reportApiData: (snapshot) =>
                        console.debug('[host-page-data]', snapshot.source, snapshot.data),
                    },
                    initial,
                  }),
              })
            : null,
        ]),
      ])
  },
})

app.use(router).use(createPinia()).use(ElementPlus).mount('#app')

// 便于验收时手工核对（控制台里 __waHostRouter 可看宿主路由；runtime 由 debug 模式挂在 __waRuntime）
Object.defineProperty(globalThis, '__waHostRouter', { configurable: true, get: () => router })
