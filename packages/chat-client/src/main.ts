import { mountWebAssistant } from './index.js'
import './style.css'

// SPA demo 入口：vite proxy 把 /wc 代理到 demo-app 的静态服务器，/api 代理到 agent-server。
// services 里全部是框架无关的纯函数 / 纯数据 —— 会被容器 provide 给业务 WC。
//
// 欢迎页覆盖示例（缺省用内置 WelcomePage）。欢迎页 = 渲染区空态：runtime 没有渲染子 WC 时展示欢迎语 + 能力卡片。
//   import MyWelcome from './components/MyWelcome.vue'
//   mountWebAssistant('#app', { ..., welcome: MyWelcome })   // 换组件（收到 text / capabilities / loading）
//   mountWebAssistant('#app', { ..., welcome: false })       // 关闭欢迎页（回退最小空态）
//   mountWebAssistant('#app', { ..., initialPage: true })    // 不要欢迎页：首屏直接打开第一个页面
// 模板式宿主也可用 <WebAssistant><template #welcome="{ text, capabilities, loading, variant }">…</template></WebAssistant>
// headless 宿主：useWebAssistant().welcomePage（变体/文案/能力清单/加载态已合并好）+ 导出的 WelcomePage（逻辑同源）
mountWebAssistant('#app', {
  wcBase: '/wc',
  agentBase: '/api',
  title: 'Web Assistant',
  subtitle: '对话式页面助手（demo）',
  // 打开「执行监视」面板：WC 活动时间线（方法调用 / 导航 / 事件 / 数据上报 / 网络 / 错误）
  showActivityLog: true,
  // 调试模式：暴露 globalThis.__waActivities / __waRuntime，控制台可直接手动触发一次页面方法调用
  debug: true,
  services: {
    request: async (url: string, init?: RequestInit) => {
      const res = await fetch(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      return res.json()
    },
    t: (key: string) => key,
    getToken: () => 'demo-token',
    state: { user: { name: '宿主用户' } },
    emit: (event, payload) => console.info('[page-event]', event, payload),
  },
})
