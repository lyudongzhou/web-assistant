// demo-app 的 Vue 批次容器入口（wc.pages.json 的 container，构建成 dist-ce/containers/vue.js）。
//
// 这里是「应用级上下文」的**总装车间**，页面靠同批构建共享同一份 chunk/实例：
// - store(pinia)     → plugins 注入，页面 useStore 拿到同一实例
// - store 镜像       → 宿主 pinia 的数据按快照 hydrate 进本批同名 store（createStoreMirror）
// - router           → runtime 自动 createVueRouter 并桥接（无需手动）
// - element-plus     → plugins 注册 + shadowStyles(基座) + lightDomStyles(浮层补丁)
// - tailwind         → 编译产物 ?inline 进 shadowStyles(base 层)，页面 class 生效
// - axios            → 这里创建实例 + 拦截器统一 apiBus.report，setHttp 接管老代码
import { createStoreMirror, defineVueContainer } from '@webassistant/wc-runtime-vue'
import ElementPlus from 'element-plus'
import elementPlusCss from 'element-plus/dist/index.css?inline'
import { createPinia } from 'pinia'
import tailwindCss from './tailwind.css?inline'
import { setHttp, type RequestFn } from '../utils/request'
import { httpClient } from '../utils/httpClient'

// 宿主 store → CE 的镜像端（每个批次一份）：宿主 pinia 里的 store 变更会推到 state 桥的
// `store:<id>` 快照上，这里把它 hydrate 进本批 pinia 的同名 store —— 页面代码零改动，
// 详见 docs/INTEGRATION_GUIDE.md「宿主 store 里的数据怎么进 CE」。
const storeMirror = createStoreMirror()

export default defineVueContainer({
  // ① store + ② element-plus：每个页面 app 都会 app.use —— 全局组件/store 不随 provide 继承，必须逐 app 注册
  //    pinia 上的插件：本批每个 store 创建时自动挂上「宿主快照 → 本 store」的镜像
  plugins: [createPinia().use(storeMirror.plugin), ElementPlus],

  // ③ tailwind + element-plus：base 层进容器 shadow root（:root 自动重写为 :host）
  //    tailwind 放前面做 reset，EP 样式在其上覆盖
  shadowStyles: [tailwindCss, elementPlusCss],
  // element-plus 浮层（el-select 下拉 / tooltip / dialog）teleport 到 body，跑出 shadow 边界，
  // 已知泄漏点，补一份光 DOM 样式
  lightDomStyles: [elementPlusCss],

  // ④ axios：接管批次的共享 HTTP 实现，老代码 `import http` 无需改动。
  //    httpClient 的拦截器已把每个响应 apiBus.report 上报给 agent（方案 B）
  setup(context) {
    // 宿主 store 镜像：把 state 桥里的 `store:<id>` 快照灌进本批同名 store，并持续同步
    storeMirror.attach(context)

    // ⚠️ 不能直接把 axios 实例当 RequestFn 传：axios 被调用返回 AxiosResponse（{data,status,...}），
    //    而 RequestFn 契约是返回裸数据（fallback 的 fetch(url) 返回 res.json()）。必须包一层取 .data。
    const adapter: RequestFn = async (url, init) => {
      const res = await httpClient.request({
        url,
        method: (init?.method ?? 'GET') as never,
        data: init?.body,
        headers: init?.headers as Record<string, string> | undefined,
      })
      return res.data
    }
    setHttp(adapter)

    // 宿主 token 打进请求头（「接口依赖宿主 store 里的 token」的标准解法：纯函数按需取用）。
    // ⚠️ 必须**每次请求现读** `context.services.getToken`：context.services 是 getter（→ servicesRef.current），
    //    若在这里把它捕获成局部变量，宿主「登录后才 setServices({ getToken })」就永远拿不到（stale 捕获）。
    httpClient.interceptors.request.use((config) => {
      const token = context.services.getToken?.()
      if (token) (config.headers as Record<string, string>).Authorization = `Bearer ${token}`
      return config
    })
  },

  // ⑤ 其它应用级上下文：自定义 provide / 逐 app 钩子
  provides: {
    // MY_SYMBOL: anything,   // 页面 app.provide 能拿到的额外东西
  },
  configureApp(app, { context, router }) {
    // 每个页面 app 的完全自定义钩子（如注册全局指令 / 再 app.use 一次插件）
    void context
    void router
    app.config.errorHandler = (err) => {
      // 示例：把页面运行错误回传给宿主（可用 context.emit 转发给 agent）
      console.error('[demo container] page error:', err)
    }
  },
})


