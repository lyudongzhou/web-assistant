# WebAssistant 接入指南：store / router / tailwind / element-plus / axios

> 目标读者：要在一个 Vue3 老项目里，把路由页面接入 WebAssistant runtime 的前端同学。
> 配套可运行示例：`packages/demo-app`（`src/ce/container.ts` + `src/utils/httpClient.ts` + `src/stores/userStore.ts` + `src/ce/tailwind.css`）。
> 相关设计：`docs/agent-session.md`（apiBus/方案 B）、`docs/agent-data-report-tasks.md`（改造清单）。

---

## 1. 核心心智模型（先读这个，避免踩"传 pinia 实例给 services"的坑）

```
┌───────────────────────────── 容器 batch（随你项目构建）─────────────────────────────┐
│  store(pinia)   store 镜像   router(桥)   axios(实例+拦截器)   element-plus   tailwind(css) │
│        ↓ app.use / provide / setHttp           ↓ shadowStyles / plugins              │
│                                    页面 WC（同批构建，共享同一实例/chunk）              │
└─────────────────────────────────────────────────────────────────────────────────────┘
             ↑ services 注入（宿主侧纯函数/纯数据，禁止传框架实例）
宿主项目 <WebAssistant :services="{ request, t, getToken, state, reportApiData }" />
             ↑ 宿主 store 数据：快照桥（store 镜像）/ setState / getToken（见 4.6）
```

**两条铁律**：

| 类别 | 怎么进 | 例子 |
|---|---|---|
| **runtime 自有依赖**（框架实例） | 容器里 `app.use` / `provide` / `setHttp` | pinia、vue-router、axios、element-plus、tailwind css |
| **外层传入依赖**（宿主能力） | `services` 注入，**必须框架无关** | `request`、`t`、`getToken`、`state`、`emit`、`reportApiData` |

禁止传：pinia store 实例、vue-i18n 实例、axios 实例给 services。它们有自己的容器注入通道，
要"同一份数据"用 store 快照桥（4.6）—— 宿主 pinia 与批次 pinia 永远是两个实例。

---

## 2. 接入清单（新建一个 Vue 批次要碰的文件）

```
my-project/
├── wc.pages.json            # 批次清单（页面 + 容器入口）
├── vite.ce.config.ts        # WC 构建（复用宿主插件 + wc 插件 + tailwind 插件）
├── src/ce/
│   ├── container.ts         # 容器入口：store/router/axios/ui库/tailwind 的"总装车间"
│   └── tailwind.css         # Tailwind 入口（?inline 导入）
├── src/utils/httpClient.ts  # axios 实例 + 拦截器（apiBus 上报在这）
├── src/stores/userStore.ts  # pinia store（示例）
└── src/pages/*.vue          # 业务页面（几乎零改动）
```

### 2.1 `wc.pages.json`

```json
{
  "framework": "vue",
  "container": "src/ce/container.ts",
  "pages": [
    { "name": "UserList", "tag": "user-list", "path": "/users",
      "title": "用户列表", "component": "src/pages/UserList.vue" }
  ]
}
```

- `tag` 必须含 `-`（自定义元素规范）
- `path` 支持 `:id` 参数，runtime 自动归一为 prop

### 2.2 `vite.ce.config.ts`

```ts
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { wcVuePlugin, wcBuildPlugin } from '@webassistant/vite-plugin-wc'

export default defineConfig({
  plugins: [tailwindcss(), wcVuePlugin(), wcBuildPlugin()],
})
```

> ⚠️ **vite 多实例坑**：tailwindcss v4 依赖 lightningcss，会生成带不同 peer 后缀的第二个 vite 副本，
> 导致 `Plugin` 类型被判为"两个同名但无关的类型"。已在根 `pnpm-workspace.yaml` 加
> `"vite": ^6.0.7` overrides 锁死（同 `@types/node` 的处理）。

---

## 3. 容器：五个依赖的统一注入（`src/ce/container.ts`）

```ts
import { defineVueContainer } from '@webassistant/wc-runtime-vue'
import ElementPlus from 'element-plus'
import elementPlusCss from 'element-plus/dist/index.css?inline'
import { createPinia } from 'pinia'
import tailwindCss from './tailwind.css?inline'        // Tailwind 编译产物
import { setHttp, type RequestFn } from '../utils/request'
import { httpClient } from '../utils/httpClient'        // axios 实例

export default defineVueContainer({
  // ① store + ② element-plus：每个页面 app 都会 app.use（组件/store 不随 provide 继承）
  plugins: [createPinia(), ElementPlus],

  // ③ tailwind + element-plus：base 层进容器 shadow root（:root → :host 自动重写）
  shadowStyles: [tailwindCss, elementPlusCss],
  // element-plus 浮层（下拉/tooltip/dialog）teleport 到 body，跑出 shadow 边界的补丁
  lightDomStyles: [elementPlusCss],

  // ④ axios：setup 只调一次。接管 http，老代码 `import http` 无需改动
  setup(context) {
    setHttp(httpClient as unknown as RequestFn)
    // 宿主 token → 请求头。⚠️ 必须在**每次请求时**现读 context.services.getToken：
    // context.services 是 getter（→ servicesRef.current），把它捕获成局部变量后，
    // 宿主「登录后才 setServices({ getToken })」或「中途换实现」都拿不到（stale 捕获）。
    httpClient.interceptors.request.use((config) => {
      const token = context.services.getToken?.()
      if (token) (config.headers as Record<string, string>).Authorization = `Bearer ${token}`
      return config
    })
  },

  // ⑤ 其它：自定义 provide / 逐 app 钩子
  provides: {},
  configureApp(app) {
    app.config.errorHandler = (err) => console.error('[container] page error:', err)
  },
})
```
---

## 4. 逐项说明

### 4.1 store（pinia）

- **容器**：`plugins: [createPinia()]`，与页面同批构建 → 单实例（整批页面共享）。
- **页面**：`import { useUserStore } from '../stores/userStore'`，`defineStore` 照常写。
- **不要**通过 services 传 pinia 实例（跨 bundle 副本不互通，违反框架无关约束）。
- **宿主 store 的数据怎么进页面** → 见 [4.6 宿主 store 里的数据怎么进 CE](#46-宿主-store-里的数据怎么进-ce)。
- **联动 agent**：store 状态不会自动同步给 agent；要让 agent 看到，用 `apiBus.report()` 显式上报。

```ts
// src/stores/userStore.ts（示例）
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
export const useUserStore = defineStore('user', () => {
  const name = ref('张三')
  const displayName = computed(() => `${name.value}（管理员）`)
  function setUser(next: { name: string }) { name.value = next.name }
  return { name, displayName, setUser }
})
```

### 4.2 router

- **不需要你写路由表**：`wc.pages.json` → manifest → runtime 生成，容器 build 时桥接。
- **页面照旧** `useRouter().push({ name, params })`，与 agent 导航汇入**同一真相源**（NavigationController，带防回环）。
- 想加自定义导航逻辑（权限判断等）：宿主侧 `runtime.beforeEach(guard)`。
- SPA 本地验证用的 router（`src/router/index.ts`）与 WC 链路无关，只服务 `pnpm dev`。

### 4.3 tailwind

- **入口**：`src/ce/tailwind.css`：`@import 'tailwindcss';`（v4 写法）。
- **进容器**：`shadowStyles: [tailwindCss, ...]`，`?inline` 导入，base 层。
- **content 扫描**：@tailwindcss/vite 插件默认扫本批次源码（`src/`），页面用到的 class 都会生成。
- **preflight/reset**：Tailwind 的 `:root` 会被 core 的 `rewriteRootToHost` 重写为 `:host`，变量在 shadow 树内可用。
- **顺序**：把 tailwind 放 `shadowStyles` 前面做 reset，element-plus 在其上覆盖。

### 4.4 element-plus

- **容器**：`plugins: [ElementPlus]`（全局组件逐 app 注册）+ `shadowStyles`（基座）+ `lightDomStyles`（浮层补丁）。
- **页面**：`<el-button>` / `el-table` 等直接可用。
- 为什么需要 `lightDomStyles`：el-select 下拉等 teleport 到 `document.body`，跑出 shadow 边界 —— 这是隔离方案的已知泄漏点，补一份光 DOM 样式。页面/共享组件样式也会在 `patchContainer` 时自动补进光 DOM。
- 定制浮层（dialog 宽度 / 标题色等）：`<style scoped>` 的 `:deep()` **命中不了** `el-dialog` 内部 teleport 的节点（子组件 teleport 出去的节点不带页面的 `data-v-xxx`）。请改用 `dialog-class` / `popper-class` 加一个类名，再用**非 scoped** 的 `<style>` 块写覆盖：
  ```vue
  <el-dialog dialog-class="my-dialog">…</el-dialog>
  <style>
  .my-dialog .el-dialog__title { color: #f00; }
  </style>
  ```

### 4.5 axios

- **实例**：`src/utils/httpClient.ts`，容器 `setup` 里 `setHttp(httpClient)` 接管老代码的 `import http`。
- **拦截器 = apiBus 上报点**（方案 B 关键）：
- **⚠️ 不要设 baseURL**：`http()` 的契约是"传完整 URL"（页面写 `/api/users`，与 fetch 一致）。若 axios 再设 `baseURL: '/api'`，会拼成 `/api/api/users` 双重前缀。

```ts
// src/utils/httpClient.ts
import axios from 'axios'
import { apiBus } from '@webassistant/wc-runtime-vue'

export const httpClient = axios.create({ timeout: 10_000 })  // 不设 baseURL

httpClient.interceptors.response.use(
  (response) => {
    // 每个响应自动上报给 agent；runtime 按 manifest dataSources 白名单过滤/摘要
    apiBus.report({
      url: response.config.url ?? '',
      method: (response.config.method ?? 'get').toUpperCase(),
      data: response.data,
    })
    return response
  },
  (error) => Promise.reject(error),
)
```

- **页面零感知**：老代码 `import http from '../utils/request'` 一行不改，实际走 axios；拦截器统一上报，页面**不需要**手动调 `apiBus.report()`（demo-app 里 UserList/UserDetail 已去掉手动上报）。
- **⚠️ 容器 setHttp 要包一层取 .data**：axios 实例被当函数调用返回 `AxiosResponse`（`{data,status,...}`），而 `http()` 契约要裸数据（fetch 返回 `res.json()`）。容器 `setup` 里必须包成 `(url, init) => httpClient.request({...}).then(r => r.data)` 再交给 `setHttp`，否则表格/列表拿到的是 AxiosResponse 对象而非数组，数据"填不进"。

### 4.6 宿主 store 里的数据怎么进 CE

**前提认知**：宿主 pinia 与批次 pinia 是**两个实例、两份库副本**，而且宿主与批次各有一份 vue。

| 隔离层 | 事实 |
|---|---|
| 实例 | 两个 `createPinia()`：宿主 app 一个，批次容器插件里一个（整批页面共享） |
| 库副本 | 宿主产物里的 pinia 与 `dist-ce/**` 里的 pinia 是两份独立模块（各自 bundle） |
| 注入符号 | `piniaSymbol = Symbol('pinia')` 每个副本一个，`inject` 只认自己副本的 |
| 全局 activePinia | 模块级变量，每副本一份；`useStore()` 在 setup 外各自解析 |

结论：**`hostStore === ceStore` 永远不成立**。想让"同一份数据"两边都能用，走下面三条通道（按用途选）；不要试图把 pinia 实例传进 services（`wc-runtime-core/src/services.ts` 会直接告警）。

```ts
// ❌ 反例：宿主把 store 实例当服务传进去
<WebAssistant :services="{ userStore }" />
// 表现：页面首次能读到值，之后宿主改了页面不更新（响应式依赖收集跨副本不互通）
```

| 用途 | 通道 | 怎么写 |
|---|---|---|
| **接口要用宿主 store 里的 token** | `services.getToken`（纯函数，按需现读） | 宿主 `getToken: () => authStore.token`；容器拦截器里每次请求 `context.services.getToken?.()`（见 4.5 的写法） |
| 页面上要"随登录态变化"的少量数据 | 快照 `runtime.setState` | 宿主 `watch(() => ({ user: authStore.user }), (p) => runtime.setState(p), { deep: true, immediate: true })`；页面 `useRuntimeServices().state.user`（容器侧是浅响应式副本，会跟着变） |
| **老页面就是写了 `useAuthStore().token`，一个字段都不想改** | **store 快照桥（镜像）** | 宿主 `hostPinia.use(createHostStorePusher({ getRuntime: () => runtime }).plugin)`；容器 `plugins: [createPinia().use(createStoreMirror().plugin)]` + `setup: (ctx) => mirror.attach(ctx)` |

**store 快照桥（镜像）怎么工作**（demo：`packages/demo-app/src/ce/container.ts`、`packages/chat-client/src/main.ts`、`wc-demo.html`）：

```
宿主 pinia（每个 store 创建时自动挂钩）                    批次 pinia（每个 store 创建时自动挂钩）
createHostStorePusher(...).plugin                          createStoreMirror().plugin
   ├─ 首次：推 $state 快照                                    ├─ 首次：从快照 hydrate（$patch）
   └─ $subscribe：变更即推                                    └─ watch state：宿主再推就再 hydrate
        runtime.setState({ 'store:auth': {...} })  ──state 桥──▶ context.state['store:auth']
```

- **页面代码零改动**：`const auth = useAuthStore(); auth.token` 照旧。
- **自动覆盖所有 store**，不用逐个 store/字段接线（靠 pinia 公开的插件 API，不碰内部字段）。
- 宿主侧两种接入：`hostPinia.use(pusher.plugin)`（推荐）；或 `pusher.push(store)` 手动桥某几个（宿主没把 pinia 装到 app 上时插件不生效 —— pinia 插件要 install 后才移入 `_p`）。
- 推手要一个 runtime 句柄：`<WebAssistant>` 用 `onRuntimeReady`、`mountWebAssistant(...)` 用 `onRuntimeReady`、headless 用 `useWebAssistant().runtime` / `useRuntimeHost().runtime`（都是框架无关 API）。
- **边界**（必须知道，否则会踩坑）：
  - 只同步可序列化 `$state`；**getter（computed）不在 `$state` 里**（要用就在页面自己算，或让宿主把派生值也放进 state）。
  - 不是同一个对象：`ceStore.user !== hostStore.user`；action 不过桥（要触发宿主行为用 `context.emit(...)`）。
  - 宿主每次推送必须是**新对象**（推手已帮你深拷贝纯数据）：state 桥用 `Object.is` 判等，推同一个引用会被当成"没变化"。
  - 默认单向（宿主为真相源）。要双向：`createStoreMirror({ twoWay: true })` + 宿主 `services.emit` 里 `if (event === STORE_PATCH_EVENT) applyHostStorePatch(authStore, payload)`。
- **真的想"共用同一个实例"？** 前提是连 vue 一起共享：CE 构建 `external: ['vue','vue-router','pinia','element-plus']` + 宿主用 import map 指向同一份 URL。代价是页面 bundle 不再自包含（不能独立验收/独立部署、版本被宿主锁死、多宿主共存冲突），一般不值得。

---

## 5. services（宿主注入，框架无关边界）

宿主嵌入 `<WebAssistant>` 时传入 —— **全部必须是纯函数/纯数据**：

```vue
<WebAssistant
  wc-base="/wc"
  ws-base="/ws"
  :services="{
    request: myFetch,               // 或什么都不传，页面走批次内 http(axios)
    t: (k) => i18nT(k),
    getToken: () => localStorage.getItem('token'),
    state: { user: { name: '宿主用户' } },
    emit: (event, payload) => log(event, payload),
  }"
/>
```

---

## 6. 老项目页面"零改动"修行清单

| 老项目写法 | WC 批次内表现 | 需要改吗 |
|---|---|---|
| `import http from '@/utils/request'` | 容器 `setHttp(axios)` 接管 | 否 |
| `useRouter().push(...)` | runtime 桥（防回环） | 否 |
| `<el-button>` 等 EP 组件 | 容器 plugins | 否 |
| `class="flex px-4"` | tailwind 进 shadow root | 否 |
| `useStore()` / `defineStore` | 容器 pinia | 否 |
| 让 agent 看到请求数据 | axios 拦截器自动 `apiBus.report` | 否 |
| 让 agent 看到组件交互数据 | 加一行 `apiBus.report({ url, data })` | 是（可选） |

---

## 7. 常见问题（FAQ）

| 现象 | 原因/对策 |
|---|---|
| 请求变成 `/api/api/users`（双重前缀） | axios 设了 `baseURL: '/api'` 但页面传的已是完整 `/api/users`。http() 契约是"传完整 URL"，**别设 baseURL** |
| 数据"填不进"表格/列表（拿到 AxiosResponse） | `setHttp` 直接传了 axios 实例。要包一层 `(url, init) => axios.request({...}).then(r => r.data)` 转成裸数据 |
| dev 模式下页面没数据 | demo-app 的 vite.config.ts 缺 `/api` proxy（加到 `http://localhost:8080`，serve.mjs 的 mock） |
| 页面 class 不生效 | tailwind 插件 content 没扫到该目录；或产物没重新 build |
| 报"两个同名但无关的 Plugin 类型" | vite 多实例，根 `pnpm-workspace.yaml` overrides 锁 `"vite": ^6.0.7` |
| 页面用不了 pinia | 容器没 `plugins: [createPinia()]`；页面在 SPA 模式也要 `.use(createPinia())` |
| 宿主登录后，页面里 `useAuthStore().token` 还是空 | 宿主 store 与批次 store 是两个实例（不共享）；按 4.6 接 store 快照桥，或让页面用 `services.getToken` / `context.state` |
| 接口请求头里没有宿主 token | 容器拦截器把 `getToken` **捕获成了局部变量**（stale 捕获）。改成每次请求现读 `context.services.getToken?.()`（见 4.5） |
| 页面 store 值"首次能读、之后不更新" | 跨副本传了宿主的响应式实例（pinia store / ref）。改走 store 快照桥或 `runtime.setState` 快照 |
| 宿主改了 store，页面没动 | 推的是同一个对象引用（state 桥用 `Object.is` 判等 → 认为没变化）；每次推**新对象**（`cloneHostState` 已处理） |
| axios 请求没上报 agent | 拦截器没装；或 manifest 该页面没声明 `dataSources`（白名单过滤） |
| el-select 下拉样式错乱 | 容器缺 `lightDomStyles`（浮层 teleport 到 body 的补丁） |
| 页面里 `useRoute()` 拿不到参数 | 用 `defineProps` 的 `id` prop（runtime 会把 params 归一为 prop） |

---

## 8. 渲染区欢迎页（空态）自定义

欢迎页 = **runtime 当前没有页面（没有渲染子 WC）** 时渲染区的默认内容，不是独立功能。
判据来自 runtime：`RuntimeView.tag === null`（等于 `Runtime.hasPage === false`）。默认首屏**不自动打开页面**，
所以真实流程是「刷新 → 欢迎页 → 用户说话 / agent render → 页面接管渲染区」。

### 8.1 三种覆盖方式（模板宿主）

```vue
<!-- ① 具名插槽：入参是合并后的完整状态（text / capabilities / loading / variant + welcome / routes / currentTag） -->
<WebAssistant wc-base="/wc">
  <template #welcome="{ text, capabilities, loading, variant }">
    <MyWelcome :text="text" :items="capabilities" :loading="loading" :variant="variant" />
  </template>
</WebAssistant>

<!-- ② 传组件：组件收到 text / capabilities / loading 三个 prop -->
<WebAssistant wc-base="/wc" :welcome="MyWelcome" />

<!-- ③ 关闭：回退最小空态（“暂无页面 / 在左侧对话中描述你想打开的页面”） -->
<WebAssistant wc-base="/wc" :welcome="false" />
```

```ts
// ④ 命令式挂载同样支持
mountWebAssistant('#app', { wcBase: '/wc', welcome: MyWelcome })
// 不需要欢迎页：让首屏直接进页面
mountWebAssistant('#app', { wcBase: '/wc', initialPage: true })            // manifest 第一个页面
mountWebAssistant('#app', { wcBase: '/wc', initialPage: 'user-list' })     // 指定 tag
```

### 8.2 headless：自己渲染，但复用同一份逻辑

```ts
import { WelcomePage, useWebAssistant } from '@webassistant/chat-client'

const { welcomePage, hasPage, currentTag, error } = useWebAssistant({ wcBase: '/wc', wsBase: '/ws' })
// welcomePage.variant / .visible / .text / .capabilities / .loading
// 也可以只用原始数据自己合并：welcome / routes / currentTag / sessionReady / manifestSettled
```

`welcomePage` 与内置 `WelcomePage.vue` 共用同一份逻辑（`lib/welcome.ts`），不会出现「内置有兜底、自定义没有」的漂移：

| 输出 | 含义 |
|---|---|
| `variant` | `page`（有页面，渲染区被页面接管）/ `welcome-loading`（无页 + 数据源未就绪）/ `welcome` |
| `text` | 欢迎语：agent 握手载荷优先，缺省回退 `DEFAULT_WELCOME_TEXT` |
| `capabilities` | 能力卡片：agent 载荷优先；旧服务端未下发时用本地 manifest 路由兜底（`tag` / `name` / `title`） |
| `loading` | 是否仍在等数据源（`session.ready` / manifest 都未 settle；**失败也算 settle**，不会死转圈） |

> 注意：欢迎页组件由**宿主构建的 Vue**渲染（light DOM），因此可以用宿主自己的 UI 库 / 主题变量（`--wa-*`）。
> 容器内的 `renderEmpty`（批次内空态）是另一回事：它属于容器 shadow DOM 内部、由被服务项目配置。
