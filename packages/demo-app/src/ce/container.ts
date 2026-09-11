// demo-app 的 Vue 批次容器入口（wc.pages.json 的 container，构建成 dist-ce/containers/vue.js）。
//
// 这里是「应用级上下文」的**总装车间**，页面靠同批构建共享同一份 chunk/实例：
// - store(pinia)     → plugins 注入，页面 useStore 拿到同一实例
// - router           → runtime 自动 createVueRouter 并桥接（无需手动）
// - element-plus     → plugins 注册 + shadowStyles(基座) + lightDomStyles(浮层补丁)
// - tailwind         → 编译产物 ?inline 进 shadowStyles(base 层)，页面 class 生效
// - axios            → 这里创建实例 + 拦截器统一 apiBus.report，setHttp 接管老代码
import { defineVueContainer } from '@webassistant/wc-runtime-vue'
import ElementPlus from 'element-plus'
import elementPlusCss from 'element-plus/dist/index.css?inline'
import { createPinia } from 'pinia'
import tailwindCss from './tailwind.css?inline'
import { setHttp, type RequestFn } from '../utils/request'
import { httpClient } from '../utils/httpClient'

export default defineVueContainer({
  // ① store + ② element-plus：每个页面 app 都会 app.use —— 全局组件/store 不随 provide 继承，必须逐 app 注册
  plugins: [createPinia(), ElementPlus],

  // ③ tailwind + element-plus：base 层进容器 shadow root（:root 自动重写为 :host）
  //    tailwind 放前面做 reset，EP 样式在其上覆盖
  shadowStyles: [tailwindCss, elementPlusCss],
  // element-plus 浮层（el-select 下拉 / tooltip / dialog）teleport 到 body，跑出 shadow 边界，
  // 已知泄漏点，补一份光 DOM 样式
  lightDomStyles: [elementPlusCss],

  // ④ axios：接管批次的共享 HTTP 实现，老代码 `import http` 无需改动。
  //    httpClient 的拦截器已把每个响应 apiBus.report 上报给 agent（方案 B）
  setup(context) {
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
    // context.services.* 可读宿主注入的 t/getToken 等，用于拦截器拼请求头。
    // 示例：把宿主 token 打进 axios 默认头（getToken 是纯函数，符合框架无关约束）
    const getToken = context.services.getToken
    if (typeof getToken === 'function') {
      httpClient.interceptors.request.use((config) => {
        const token = getToken()
        if (token) (config.headers as Record<string, string>).Authorization = `Bearer ${token}`
        return config
      })
    }
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


