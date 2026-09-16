// SPA demo 入口：vite proxy 把 /wc 代理到 demo-app 的静态服务器，/api /ws 代理到 agent-server。
//
// 本文件是「**demo 宿主**」—— 它同时演示本包的两个身份：
//   ① 宿主：挂载 <WebAssistant>（`mountWebAssistant`）+ 自己的 pinia / services / 登录态
//   ② 消费端 API：从本包 import 面板组件与 hooks；**上报通道 `apiBus` 也从本包导出**
//
// ⚠️ 数据上报的分工（新原则：runtime 不采集任何请求，谁想看谁显式上报）：
//   - 页面数据（接口响应）→ 由**被服务项目**的页面代码在调用点上报（见 demo-app 的 reportData）
//   - 宿主侧事实（登录态 / 宿主上下文 / 纯前端状态）→ 由**宿主**在这里上报（见下面 reportHostContext）
//   两边都不调 = agent 侧一条业务数据都没有（只有 page.navigated / page.exposed 这类元信息）。
//
// —— 宿主 store → CE 页面 store（快照桥）本例 ——
// 宿主有自己的 pinia（与批次里那份是**两个实例、两份 vue 副本**），
// 用 createHostStorePusher 把每个 store 的 $state 推成 state 桥里的 `store:<id>` 快照；
// CE 侧容器（demo-app src/ce/container.ts）用 createStoreMirror 灌进同名 store。
// 页面里 `useAuthStore().token` 一行不改就有值；接口要 token 则由 services.getToken 现读。
import { ref } from 'vue'
import { createPinia, defineStore } from 'pinia'
import { createHostStorePusher } from '@webassistant/wc-runtime-vue/host'
// apiBus：从本包导出（与 wc-runtime-vue / wc-runtime-core 是同一个全局单例）——
// demo 宿主用它演示「宿主侧显式上报」，也顺带验证「只装 chat-client 也有上报入口」。
import { apiBus, mountWebAssistant } from './index.js'
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

/**
 * 宿主侧显式上报：把**宿主才知道的事实**交给 agent（登录态 / 角色 / 宿主上下文…）。
 *
 * - 这是「宿主 → agent」的唯一通道；**不调就没有数据出浏览器**（runtime 不自动采集任何请求）。
 * - 报什么、报哪些字段，全由宿主在这里决定 —— 敏感值（token / 手机号）不要出浏览器。
 * - 返回 `false` = 此刻没有 assistant 在监听（同一份代码跑在没挂面板的页面里时正常出现），
 *   开发期用它自检「上报有没有生效」。
 */
function reportHostContext(trigger: 'ready' | 'login' | 'logout'): void {
  const delivered = apiBus.report({
    source: 'host-context',
    data: {
      // trigger 让 agent 知道「为什么现在有这份数据」（避免把人主动点击也当成页面事实）
      trigger,
      loggedIn: Boolean(auth?.user),
      user: auth?.user ? { name: auth.user.name, role: auth.user.role } : null,
      // ⚠️ 故意不给 token：报什么由宿主决定，凭证类字段一律不出浏览器
    },
  })
  console.debug('[host-report]', `${trigger} →`, delivered ? 'delivered' : 'no-listener（未挂面板时会这样）')
}

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
    // runtime 就绪 → 推手拿到句柄（之后 store 变更就会自动推到 CE）；顺带把宿主当前事实报给 agent
    onRuntimeReady: (runtime) => {
      runtimeHolder.runtime = runtime
      if (auth) pusher.push(auth)
      reportHostContext('ready')
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
      // 消费侧钩子（与上面的生产侧 report 相对）：任何显式上报流经 runtime 后宿主也能拿到，
      // 用于本地留痕 / 埋点；注意它**不**代表 agent 收到了什么。
      reportApiData: (snapshot) => console.debug('[host-page-data]', snapshot.source, snapshot.data),
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
  // 宿主侧事实变了 → 显式报给 agent（登录态本身就是 agent 决策要用的上下文）
  reportHostContext('login')
})
const logoutBtn = document.createElement('button')
logoutBtn.textContent = '登出'
logoutBtn.style.cssText = loginBtn.style.cssText
logoutBtn.addEventListener('click', () => {
  auth?.logout()
  label.textContent = '宿主 store：未登录'
  reportHostContext('logout')
})
bar.append(label, loginBtn, logoutBtn)
document.body.appendChild(bar)
