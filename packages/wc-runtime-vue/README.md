# @webassistant/wc-runtime-vue

WC runtime 的 **Vue 实现**，也是**唯一对外门面**：宿主、批次容器入口、页面入口都只 import 本包，
不需要感知 [`@webassistant/wc-runtime-core`](../wc-runtime-core)（定义层，作为本包的 dependency）。

```
createVueRuntime()   宿主用：加载 manifest、按 framework 懒建容器、按 tag 渲染业务 WC
defineVueContainer() 批次容器入口用：<runtime-vue> = 样式隔离边界 + 公共依赖/服务注入点
definePage()         页面入口用：把 .vue 页面注册成业务 WC（shadowRoot:false）
useRuntimeServices() 页面里用：拿 request / t / state / nav
```

---

## 1. 三个消费者

### ① 宿主（chat-client / ontology）

```ts
import { createVueRuntime } from '@webassistant/wc-runtime-vue'

const rt = createVueRuntime({
  manifestUrl: '/wc/manifest.json',
  assetBase: '/wc/dist-ce',
  // 外层传入的依赖：必须框架无关（纯函数 / 纯数据 / 订阅回调）
  services: {
    request,
    t: (key, ...args) => i18n.global.t(key, ...args),
    getToken: () => hostStore.token,
    theme: { '--el-color-primary': '#409eff' },
    state: { user: hostStore.user },              // 业务状态快照
    emit: (event, payload) => sendEvent(event, payload),
  },
  containerStrategy: 'keep',                       // 跨框架切换时保留非活跃容器实例
  preload: 'none',                                 // 'all' 可首屏收齐全部页面样式
})

rt.on('navigate', ({ route, source, canGoBack }) => { title.value = route.title })
rt.on('page-event', ({ tag, event, payload }) => forwardToAgent(tag, event, payload))
rt.on('error', (e) => console.warn(e.message))

await rt.init(mountEl)
await rt.navigate({ tag: 'user-detail', params: { id: 7 }, source: 'agent', replace: true })

watch(() => hostStore.user, (user) => rt.setState({ user }), { deep: true })
rt.setServices({ locale: 'en-US' })
rt.back(); rt.canGoBack; rt.dispose()
```

### ② 批次容器入口（`wc.pages.json` 的 container，构建成 `containers/vue.js`）

```ts
import { defineVueContainer } from '@webassistant/wc-runtime-vue'
import ElementPlus from 'element-plus'
import epCss from 'element-plus/dist/index.css?inline'
import { createPinia } from 'pinia'

export default defineVueContainer({
  tagName: 'runtime-vue',
  plugins: [ElementPlus, createPinia()],   // 每个页面 app 都会 app.use
  shadowStyles: [epCss],                   // 注入容器 shadow root（:root 自动重写为 :host）
  lightDomStyles: [epCss],                 // teleport 浮层用（隔离方案的已知泄漏点）

  // 一次性钩子：配置批次内的共享单例（axios 拦截器 / dayjs locale / echarts 主题）
  // 只在容器创建时调一次，早于任何页面注册；context 是稳定引用，读 services 永远是最新值
  setup(context) {
    setHttp(context.services.request)
    http.interceptors.request.use((cfg) => {
      const token = context.services.getToken?.()
      if (token) cfg.headers.Authorization = `Bearer ${token}`
      return cfg
    })
  },
  // renderEmpty / renderLoading / renderError 可自定义
})
```

> **UI 库与 store 属于「runtime 自有依赖」**：写在这里就随本批次 bundle 构建，和页面共享同一份 chunk。
> 不要让宿主经 services 传 element-plus / pinia 实例 —— 跨框架副本的响应式与全局组件都会失效。

**宿主 store 的数据怎么给页面 store 用（store 快照桥/镜像）**：宿主 pinia 与批次 pinia 是两个实例、
两份库副本（连 vue 都是两份），所以"共享同一个实例"不成立；要同一份数据就走快照镜像：

```ts
// 宿主侧（宿主自己的 pinia）
import { createHostStorePusher } from '@webassistant/wc-runtime-vue/host'
const pusher = createHostStorePusher({ getRuntime: () => runtime })  // runtime 来自 useRuntimeHost().runtime / onRuntimeReady / createHostRuntime
hostPinia.use(pusher.plugin)        // 之后创建的每个 store：创建即推一次，变更即推（自动覆盖，不用逐个字段接线）
// 没有宿主 app（pinia 插件不生效）或只想桥某几个 store：pusher.push(useAuthStore())

// 批次容器侧
import { createPinia } from 'pinia'
import { createStoreMirror, defineVueContainer } from '@webassistant/wc-runtime-vue'
const mirror = createStoreMirror()   // 可选 { only: ['auth'], twoWay: true }
export default defineVueContainer({
  plugins: [createPinia().use(mirror.plugin), ElementPlus],
  setup(context) { mirror.attach(context) },
})
```

页面里 `useAuthStore().token` **一行不用改**就有值（拿到的是镜像值）。边界：只同步可序列化 `$state`
（getter/action/对象身份不过桥）、默认单向（宿主为真相源）；接口要 token 请另外给 `services.getToken`
纯函数（容器每次请求现读，比读 store 更干净）。

### ③ 页面入口（vite-plugin-wc 生成，构建成 `pages/*.js`）

```js
import Page from '<component>'
import { definePage } from '@webassistant/wc-runtime-vue'
export const styles = Page.styles || []
export default (api) => definePage(Page, api)
```

### 页面内部（老代码几乎不用改）

```vue
<script setup>
import { useRouter, useRoute } from 'vue-router'          // 容器内建 memory router，照常可用
import { useRuntimeServices } from '@webassistant/wc-runtime-vue'

const router = useRouter()
const route = useRoute()

// ⚠️ 不要解构 request / services —— 它们是 getter，解构会把当时的值固化，
//    之后 rt.setServices({ request }) 不会生效。t / emit / nav / state 是稳定引用，解构没问题。
const ctx = useRuntimeServices()
await ctx.request.get('/users')

// 同一个页面组件既要在 runtime 容器里跑、也要在原项目 SPA 里跑时，用可选版本：
// const ctx = tryUseRuntimeServices()   // 拿不到返回 null

// 两种导航都会驱动 runtime 切换业务 WC：
router.push({ name: 'UserDetail', params: { id: 3 } })     // 老写法
ctx.nav.push({ tag: 'user-detail', params: { id: 3 } })    // 框架无关写法（back 推荐用 nav.back()）
</script>
```

---

## 2. `router.push` 如何驱动 runtime 切 WC

容器内建一个 memory `vue-router`，由 `createVueRouterBridge` 与 core 双向同步，三个机制：

| 机制 | 实现 | 为什么必须 |
|---|---|---|
| 路由表同步 | core routes → `addRoute`，component 是哑组件 `{ render: () => null }` | `push({ name })` 要求 name 存在；渲染由容器按 `tag` 负责，**不走 `<router-view>`** |
| guard 前移 | core guard 挂进 `beforeEach` → 拒绝时返回 `false` | 否则页面 `push` 一定"成功"而 core 却拒绝，两边状态分裂；现在页面能拿到 `NavigationFailure` |
| 防回环 | `applying` **计数器**（不是布尔），`apply()` 前 `++`、`.finally` 里 `--`；`afterEach` 见 `applying>0` 直接返回 | vue-router 导航是异步的，布尔 flag 会被并发导航打穿 |

```
页面 useRouter().push({ name:'UserDetail', params:{ id:3 } })
  → beforeEach → api.canNavigate(target)        （core guard）
  → afterEach  → api.commit(target, source:'page')
  → core：ensure 容器 → nav.commit → view{ tag:'user-detail', props:{ id:3 } }
  → patchContainer → 容器渲染 <user-detail :id="3">
  → 'navigate' 事件（宿主更新标题 / 返回按钮 / 可回传 agent）
  ✗ 不再 apply 回 vue-router（防回环）

agent rt.navigate({ tag, params, source:'agent' })
  → core 同上 → 最后 bridge.apply() 把 vue-router 推到同一位置（页面里 useRoute().params 也对得上）
```

## 3. 依赖与服务是怎么到页面的

| 通道 | 内容 | 机制 |
|---|---|---|
| runtime 自有 | vue / vue-router / element-plus / pinia | 同批构建的共享 chunk（同一模块实例） |
| 全局组件 / 插件 | `plugins: [ElementPlus, pinia]` | **每个页面 app 都 `app.use`** —— `app.use` 的全局组件不随 provide 继承，必须逐 app 注册 |
| 外层服务 | `request / t / getToken / theme / state / emit` | 容器 `app.provide(RUNTIME_CONTEXT_KEY, ctx)`；页面 CE 是嵌套 `VueElement`，Vue 3.5 `_inheritParentContext` 会把父容器的 provides 挂到子 app 的 provides 原型上，`definePage` 里也会再 provide 一次做兜底 |
| i18n 宏 | `$tt` / `$t` | `app.config.globalProperties.$tt = ctx.t`，并兜底挂 `window.$tt` |
| 业务状态 | `state` | core `StateBridge`（纯数据）→ 容器 `shallowReactive` 副本 → 页面响应式可用；`rt.setState()` 浅合并同步 |
| 页面事件 | `emit` | 页面 `emit('save', data)` → Vue CE 派发 `CustomEvent`（`composed:false`，停在容器 shadow root 内）→ 容器按 `view.events` 挂的监听 → `page-event` |

> 单副本前提下**不需要**手动桥接 `routerKey` 等 symbol（旧 `wc-runtime/routerInject` 的做法），
> `app.use(router)` 直接可用。这也是「容器与页面必须同批构建」这条硬约束换来的收益。

## 4. 容器渲染的 view 与状态

`patchContainer` 把 `RuntimeView` 写成容器元素的 **property**（对象不能走 attribute）：
`tag / pageProps / pageStyles / stylesVersion / status / error / events`。
容器 render 分支：`error → renderError`、`!tag → renderEmpty`、`loading → renderLoading`、否则
`h(tag, { '.prop': value, onEvent })` —— props 一律加 `.` 前缀强制走 DOM property，
未升级元素上的赋值会被 Vue 的 `_resolveProps` 在 connect 时回收。

## 5. 已知限制

- 页面内嵌套子路由（页面自己的 `<router-view>`）暂不支持。
- 页面内 `router.back()` 会被 core 视为一次新导航（history 增长）；请用 `nav.back()` 或宿主返回按钮。
- UI 库浮层 teleport 到 `document.body`，逃出容器 shadow root —— 用 `lightDomStyles` 补一份光 DOM 样式；
  页面/共享组件样式也会在 `patchContainer` 时自动补一份进光 DOM（内容哈希去重、append-only）。
  但页面 `<style scoped>` 的 `:deep()` 命中不了 `el-dialog` 这类**子组件内部** teleport 的节点
  （它们不带页面的 `data-v-xxx`），定制浮层请用 `dialog-class`/`popper-class` + 非 scoped `<style>` 块。
- `customElements.define` 不可注销，`dispose()` 只解绑与卸载 DOM，不回收元素定义。
- 多个 runtime 共享同一个**容器 bundle 模块**时 adapter 是模块单例（内建 router 也共享）；
  `createVueRuntime({ container })` 走本地 adapter 模式则每个 runtime 独立。

## 6. 开发

```bash
pnpm --filter @webassistant/wc-runtime-vue build
pnpm --filter @webassistant/wc-runtime-vue test
```

`test/adapter.test.js` 用最小 DOM 桩验证契约接线（bridge 三机制、patchContainer 属性写入、context 注入）。
**注意桩的顺序**：vue-router 在模块初始化时用 `typeof document !== 'undefined'` 判定 `isBrowser`，
必须先 import 依赖 vue-router 的模块，之后才装 `document` 桩。真正的渲染 / 样式行为留给 demo 端到端验证。

