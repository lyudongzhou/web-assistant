// SPA demo 入口：vite proxy 把 /wc 代理到 demo-app 的静态服务器，/api /ws 代理到 agent-server。
//
// —— 宿主 store → CE 页面 store（快照桥）本例 ——
// 宿主有自己的 pinia（与批次里那份是**两个实例、两份 vue 副本**），
// 用 createHostStorePusher 把每个 store 的 $state 推成 state 桥里的 `store:<id>` 快照；
// CE 侧容器（demo-app src/ce/container.ts）用 createStoreMirror 灌进同名 store。
// 页面里 `useAuthStore().token` 一行不改就有值；接口要 token 则由 services.getToken 现读。
import { ref } from 'vue'
import { createPinia, defineStore } from 'pinia'
import { createHostStorePusher } from '@webassistant/wc-runtime-vue/host'
import { mountWebAssistant } from './index.js'
import type { Runtime } from './types.js'
import './style.css'

// services 里全部是框架无关的纯函数 / 纯数据 —— 会被容器 provide 给业务 WC。
//
// 欢迎页覆盖示例（缺省用内置 WelcomePage）。欢迎页 = 渲染区空态：runtime 没有渲染子 WC 时展示欢迎语 + 能力卡片。
//   import MyWelcome from './components/MyWelcome.vue'
//   mountWebAssistant('#app', { ..., welcome: MyWelcome })   // 换组件（收到 text / capabilities / loading）
//   mountWebAssistant('#app', { ..., welcome: false })       // 关闭欢迎页（回退最小空态）
//   mountWebAssistant('#app', { ..., initialPage: true })    // 不要欢迎页：首屏直接打开第一个页面
// 模板式宿主也可用 <WebAssistant><template #welcome="{ text, capabilities, loading, variant }">…</template></WebAssistant>
// headless 宿主：useWebAssistant().welcomePage（变体/文案/能力清单/加载态已合并好）+ 导出的 WelcomePage（逻辑同源）

// ---- 宿主 pinia：一个「auth store」（真实项目里就是你们的登录态 store）----
const useHostAuthStore = defineStore('auth', () => {
  const token = ref('')
  const user = ref<{ name: string; role: string } | null>(null)
  function login(): void {
    token.value = `tk-${Date.now().toString(36)}`
    user.value = { name: '宿主用户', role: '管理员' }
  }
  function logout(): void {
    token.value = ''
    user.value = null
  }
  return { token, user, login, logout }
})

const hostPinia = createPinia()
// 推手：懒取 runtime（首屏 init 之前拿不到，且 init 之前 setState 会抛）
const runtimeHolder: { runtime: Runtime | null } = { runtime: null }
const pusher = createHostStorePusher({ getRuntime: () => runtimeHolder.runtime })
hostPinia.use(pusher.plugin)

// store 要在 pinia 被 app.use 之后创建（pinia 插件才会生效）——所以先挂载，再取 store
let auth: ReturnType<typeof useHostAuthStore> | null = null

mountWebAssistant(
  '#app',
  {
    wcBase: '/wc',
    agentBase: '/api',
    title: 'Web Assistant',
    subtitle: '对话式页面助手（demo）',
    // 打开「执行监视」面板：WC 活动时间线（方法调用 / 导航 / 事件 / 数据上报 / 网络 / 错误）
    showActivityLog: true,
    // 调试模式：暴露 globalThis.__waActivities / __waRuntime，控制台可直接手动触发一次页面方法调用
    debug: true,
    // runtime 就绪 → 推手拿到句柄（之后 store 变更就会自动推到 CE）
    onRuntimeReady: (runtime) => {
      runtimeHolder.runtime = runtime
      if (auth) pusher.push(auth)
    },
    services: {
      request: async (url: string, init?: RequestInit) => {
        const res = await fetch(url, init)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
        return res.json()
      },
      t: (key: string) => key,
      // 接口依赖 store 里的 token：给**纯函数**，容器每次请求现读（不要把 store 实例传进去）
      getToken: () => auth?.token ?? '',
      state: { user: { name: '宿主用户' } },
      emit: (event, payload) => console.info('[page-event]', event, payload),
    },
  },
  // 宿主 pinia 必须在挂载前装上：否则 pinia 的 use(plugin) 还停在 pending 列表，store 创建时插件不会跑
  { plugins: [hostPinia] },
)

auth = useHostAuthStore()
pusher.push(auth) // 补推初始快照（此刻 runtime 可能还没 init，没 init 就不推，onRuntimeReady 里会补）

// ---- 演示用：悬浮「模拟登录/登出」按钮（真实宿主里就是你们的登录流程）----
const bar = document.createElement('div')
bar.style.cssText =
  'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:8px;align-items:center;' +
  'font:12px system-ui;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;' +
  'box-shadow:0 4px 16px rgba(0,0,0,.08)'
const label = document.createElement('span')
label.textContent = '宿主 store：未登录'
const loginBtn = document.createElement('button')
loginBtn.textContent = '登录'
loginBtn.style.cssText = 'padding:4px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer'
loginBtn.addEventListener('click', () => {
  auth?.login()
  label.textContent = `宿主 store：${auth?.user?.name ?? ''} / ${auth?.token ?? ''}`
})
const logoutBtn = document.createElement('button')
logoutBtn.textContent = '登出'
logoutBtn.style.cssText = loginBtn.style.cssText
logoutBtn.addEventListener('click', () => {
  auth?.logout()
  label.textContent = '宿主 store：未登录'
})
bar.append(label, loginBtn, logoutBtn)
document.body.appendChild(bar)
