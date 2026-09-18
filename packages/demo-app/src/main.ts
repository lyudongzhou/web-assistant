// SPA 入口：demo-app 的**唯一宿主外壳**（router + router-view + element-plus + pinia）。
//
// 一个 dev server（5173）跑完三条演示链路（详见 App.vue / packages/demo-app/README.md）：
//   ① 业务路由 + 悬浮 dock   → 用法 B（宿主直连）：agent 直接改宿主 router
//   ② /assistant 路由        → 用法 A（容器 / WC；与用法 B 共用 public/wc 的清单与 manifest）
//   ③ /lab 路由              → 能力验收室（所有探针集中在这里）
//   ④ /wc-demo.html          → runtime 层验收台（零构建直连 core dist，与 chat-client 无关）
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// ★ 助手组件库的样式入口：chat-client 是**预构建库**，SFC 样式被抽到 `dist/style.css`，
//   库的 JS 不会自动注入 —— 漏了这一行，面板就是一堆裸 HTML（host dock 与 /assistant 同样）。
import '@webassistant/chat-client/style.css'
// 设计 token（业务界面 + 面板主题的唯一来源）
import './styles/tokens.css'
import './ce/tailwind.css'
import App from './App.vue'
import router from './router'
import { hostStorePusher } from './utils/hostStoreBridge'

// ⚠️ store 快照桥必须在**任何 store 创建前**装到 pinia 上：pinia 插件只对之后创建的 store 生效，
//    而 AppShell / 路由守卫在首屏就会创建 store（细节见 utils/hostStoreBridge.ts）。
const pinia = createPinia()
pinia.use(hostStorePusher.plugin)

// ⚠️ export app / pinia：用法 B 的 runtime 需要**宿主 app** 才能把 runtime context provide 给页面
//（页面 `useRuntimeServices()` 由 null 变可用），见 components/AssistantDock.vue
export const app = createApp(App)
app.use(router).use(pinia).use(ElementPlus).mount('#app')

// 验收便利：控制台可看宿主真实路由表（runtime 在 debug 下自己挂 __waRuntime）
Object.defineProperty(globalThis, '__waHostRouter', { configurable: true, get: () => router })

export { router, pinia }


