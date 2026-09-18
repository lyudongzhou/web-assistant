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
├── src/utils/httpClient.ts  # axios 实例 + reportData()（**显式**上报入口，不做自动上报）
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
- **不做自动上报**：runtime 不拦 fetch/XHR、不监听请求。agent 能看到什么，由**调用点**显式决定；
  不调 = 零数据出浏览器（详见 §4.5.1）。
- **⚠️ 不要设 baseURL**：`http()` 的契约是"传完整 URL"（页面写 `/api/users`，与 fetch 一致）。若 axios 再设 `baseURL: '/api'`，会拼成 `/api/api/users` 双重前缀。

#### 4.5.1 显式上报（`apiBus.report`）

```ts
// src/utils/httpClient.ts —— 只提供「上报入口」，不在这里自动上报
import axios from 'axios'
import { apiBus } from '@webassistant/wc-runtime-vue'

export const httpClient = axios.create({ timeout: 10_000 })  // 不设 baseURL

/** 显式上报一份数据给 agent（可选动作，按需调用） */
export function reportData(source: string, data: unknown, options: { url?: string; method?: string } = {}): boolean {
  // 带 url → 命中该页 manifest 的 dataSources 时按 fields / maxRows / mask 摘要后才出网
  return apiBus.report({ source, data, url: options.url, method: options.method })
}
```

```ts
// 业务调用点（两种口径都合法，取舍是「边界写在代码里」还是「写在清单里」）
// ① 自己挑字段（无声明）
const user = await http<User>('/api/users/1')
reportData('user-detail', { id: user.id, name: user.name, role: user.role })

// ② 原始响应直接上报，边界交给清单的 dataSources 声明（见下）
const list = await http<User[]>('/api/users')
reportData('user-list', list, { url: '/api/users' })
```

**数据源声明写在哪：`wc.pages.json` 的页面条目**（单一来源，analyzer 原样透传进 manifest）：

```jsonc
{ "name": "UserList", "tag": "user-list", "path": "/users", "component": "src/pages/UserList.vue",
  "dataSources": [
    { "match": "/api/users", "fields": ["id","name","role"], "maxRows": 6,
      "primaryKey": "id", "description": "用户列表（最多 6 行；邮箱不出网）" }
  ] }
```

命中后 `source` 变为 `match` 值、并按声明裁剪；未命中或没带 `url` → 原样透传。
**声明 ≠ 自动上报**：runtime 依然零采集，仍然要在调用点显式 `report()`。


**宿主侧也要报「宿主才知道的事实」**（登录态 / 角色 / 纯前端状态）—— 这类数据页面没有，
不报 agent 就不知道（runtime 不会替你去采集）：

```ts
// 宿主代码（main.ts / 布局外壳），只装 chat-client 时也能 import 到同一个 apiBus
import { apiBus } from '@webassistant/chat-client'

function reportHostContext(trigger: 'ready' | 'login' | 'logout'): void {
  apiBus.report({
    source: 'host-context',
    data: {
      trigger,
      loggedIn: Boolean(auth.user),
      user: auth.user ? { name: auth.user.name, role: auth.user.role } : null,
      // ⚠️ 故意不给 token：报什么由宿主决定，凭证类字段一律不出浏览器
    },
  })
}
```

于是常见分工是：**页面报接口数据，宿主报宿主事实**（谁报、报什么，都在各自的调用点一目了然）。

- **为什么手动**：自动拦截宿主页面的**全部**请求，会把不相关甚至敏感的数据带出浏览器；
  靠事后白名单补救既不可靠也难维护。所以决定权回到调用点：报什么、什么时候报，一目了然。
- **import 从哪来**：`@webassistant/wc-runtime-vue`（用法 B 宿主本来就有）或 `@webassistant/chat-client`
  （用法 A 只装面板时也转出了同一个全局单例）；页面内也可用 `useRuntimeServices().reportApiData()`。
- **零数据出网是默认状态**：没有任何 `apiBus.report` 调用 = agent 侧什么数据都收不到（见 §4.5.2）。
- **不必**调 `apiBus.attach()`：消费端只有 runtime 内核一处（它是单 sink，业务侧自己 attach 会顶掉内核，
  覆盖时会 `console.warn` 提示）。`report()` 返回 `false` 表示当前没人监听
  （例如同一份页面代码跑在没挂 `<WebAssistant>` 的 SPA 里），可用于开发期自检。
- **可选加固**：若页面在 manifest 里声明了 `dataSources`（清单里写，见上）且上报带 `url` 且命中，
  runtime 会按 `fields` / `maxRows` / `mask` 再裁一层 —— 这是额外保险，不是隐私边界。
  ⚠️ 有个实际取舍：**错误载荷建议不带 `url`** —— 否则 `{ message }` 会被字段白名单裁成 `{}`，
  agent 反而看不到「接口挂了」。demo 的 `*-error` 上报就是这么写的。
- **硬上限**：runtime 侧对上报数据施加 16KB / 深度 4 上限（防 token 爆），超限置 `truncated: true`。

#### 4.5.2 agent 侧看到的效果

- 有 `apiBus.report` → ws `page.data`（`source` / `data` / `truncated` / `at`）→ 入 session → 进 prompt 的
  `[页面数据] 来源：…`；`wait_for_observation` 可用 `{ source, contains }` 等它。
- 没有调用 → agent 侧只有 `page.navigated` / `page.exposed` / `page.emit` 这些**元信息与通知**，
  一条业务数据都没有（这是设计意图，不是 bug）。
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
| 让 agent 看到请求数据 | 在调用点显式 `reportData('user-list', data)`（无自动上报） | 是（一行，可选） |
| 让 agent 看到组件交互数据 | 同上：`apiBus.report({ source, data })` | 是（可选） |

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
| agent 侧看不到任何接口数据 | **预期行为**：runtime 不自动采集。请在业务调用点显式 `apiBus.report({ source, data })`；若已声明 `dataSources` 且带 `url`，确认 URL 命中了 `match` |
| el-select 下拉样式错乱 | 容器缺 `lightDomStyles`（浮层 teleport 到 body 的补丁） |
| 页面里 `useRoute()` 拿不到参数 | 用 `defineProps` 的 `id` prop（runtime 会把 params 归一为 prop） |
| 面板是「裸 HTML」（没有气泡 / 输入栏样式） | 漏了库的样式入口（预构建库不自动注入 CSS） | `import '@webassistant/chat-client/style.css'` |
| 看得见对话、看不见输入框 | 内嵌容器没给 `--wa-height`（组件根缺省 `100vh`，被 `overflow: hidden` 裁掉底部） | 挂载点上设 `--wa-height: 100%` |

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

> 开箱即用：库导出的 `<HostAssistantDock>`（悬浮窗 = 状态行 + 对话 +「本轮动作」时间线，见 9.8）。
> 可运行示例：`packages/demo-app/src/components/AssistantDock.vue` —— 薄封装，只补 demo 自己的三样私货
> （`createVueHostRuntimeBinding` 造 runtime、宿主 store 快照桥、`__waHostRuntime` 控制台句柄）。

`welcomePage` 与内置 `WelcomePage.vue` 共用同一份逻辑（`lib/welcome.ts`），不会出现「内置有兜底、自定义没有」的漂移：

| 输出 | 含义 |
|---|---|
| `variant` | `page`（有页面，渲染区被页面接管）/ `welcome-loading`（无页 + 数据源未就绪）/ `welcome` |
| `text` | 欢迎语：agent 握手载荷优先，缺省回退 `DEFAULT_WELCOME_TEXT` |
| `capabilities` | 能力卡片：agent 载荷优先；旧服务端未下发时用本地 manifest 路由兜底（`tag` / `name` / `title`） |
| `loading` | 是否仍在等数据源（`session.ready` / manifest 都未 settle；**失败也算 settle**，不会死转圈） |

> 注意：欢迎页组件由**宿主构建的 Vue**渲染（light DOM），因此可以用宿主自己的 UI 库 / 主题变量（`--wa-*`）。
> 容器内的 `renderEmpty`（批次内空态）是另一回事：它属于容器 shadow DOM 内部、由被服务项目配置。
## 9. 用法 B：宿主直连（agent 操作你项目自己的 router）★

> 目标读者：想让 agent 直接驱动自己项目路由的前端同学。
> 与上面 1–8 章（**用法 A：容器 / WC**）的区别：不编译 Web Component、不建容器、不做样式隔离 ——
> 页面还是你自己的页面，在**你自己的 `<router-view>`** 里渲染。
> 可运行示例：`packages/demo-app/src/components/AssistantDock.vue` + `src/App.vue`（`pnpm dev` → `/`；
> **同一个** SPA 的 `/assistant` 路由是用法 A（容器 / WC）的演示 —— 两条链路一个端口对照着看）。

### 9.1 一句话

在宿主自己的 vite/vue-router 项目里 **加 2 处代码 + 1 份页面清单**，agent 的 `render` 就变成 `router.push`：
URL 真的变、页面在原来位置渲染、宿主的守卫/登录态/样式全部生效。

> 这份清单与容器模式（用法 A）**是同一份**，manifest 也是同一份（`pnpm analyze` 只跑一次）——
> 不需要 `wc.host.json`，也不需要第二次分析命令。

### 9.2 装什么 / 不装什么

| | 包 | 说明 |
|---|---|---|
| 运行时装 | `@webassistant/chat-client`、`@webassistant/wc-runtime-vue`（子入口 `host-router`）、`@webassistant/wc-runtime-core`、`@webassistant/protocol`（传递） | `host-router` 子入口不引入容器 / CE / 样式机制 |
| 开发时装 | `@webassistant/analyzer`（CLI 生成 manifest）；`@webassistant/vite-plugin-wc`（**只用 `wcManifestPlugin`** 做 dev 热生成） | `wcManifestPlugin` 与 CE 构建无关，可在普通 SPA 配置里单独用 |
| **不装** | `vite-plugin-wc` 的 `wcVuePlugin` / `wcBuildPlugin` | —— |
| **不建** | `vite.ce.config.ts`、`src/ce/container.ts`、`dist-ce/` | 页面不需要产物 |
| **不跑** | `pnpm build:ce`、静态服务器（8080 那套） | manifest 同源，不需要 `/wc` 代理 |
| **不用** | 第二份清单（`wc.host.json`） | 与容器模式**共用同一份** `wc.pages.json` → 同一份 `manifest.json`；host 面只读页面目录，其中的 `containers` / `pages[].bundle` 由 core 归一化为空后忽略（`openspec/changes/unify-page-manifest`） |
| 宿主自己的其它路由 | 登录页 / 404 / 你自己的演示页**照常工作** | runtime 只接管页面目录内的路由，其余放行（见 9.6 第 5 条） |

### 9.3 改哪 2 处代码 + 1 份清单

**① `wc.pages.json`（与容器模式共用同一份；声明 `container` 也无需删）**

```jsonc
{
  "framework": "vue",
  "container": "src/ce/container.ts",           // 容器模式要它；host 模式不读它（留着即可，一份清单两用）
  "rules": ["rules/domain.md"],                 // manifest 级规则（用法 A/B 通用）
  "pages": [
    { "name": "UserList",   "tag": "user-list",   "path": "/users",     "title": "用户列表",
      "component": "src/pages/UserList.vue" },
    { "name": "UserDetail", "tag": "user-detail", "path": "/users/:id", "title": "用户详情",
      "component": "src/pages/UserDetail.vue" }
  ]
}
```

> 🔴 **硬约束**：`name` **必须等于你项目 `router` 里那条 route 的 `name`**（`router.hasRoute(name)` 校验；
> 缺失时 init **不中断**，只 `console.warn` 一次性列出全部缺失名 —— 真实项目的页面路由常是登录后 /
> 按权限才注册的；agent 导航到这类页面时返回结构化失败 `{ ok:false, reason:'not-found' }`，
> 内核当前页与宿主 URL 都不动 —— 不会静默 404）。
> ⚠️ 若这份清单同时给容器模式用（声明了 `container`），所有 `tag` 都要满足自定义元素规范（**含 `-`**）——
> 否则 `build:ce` 会报错（analyzer 会提前警告）。

生成 manifest（与容器模式**同一条命令、同一份产物**）：

```bash
pnpm analyze         # = wc-analyze --config wc.pages.json --out public/wc/manifest.json
                     #   不需要为 host 再跑一遍；产物含 containers / bundle —— host 面会忽略它们
# 或接进 vite dev 热更新（页面源码 / 规则改动即重写 manifest）：
# wcManifestPlugin({ configPath: 'wc.pages.json', outPath: 'public/wc/manifest.json' })
```

**② `vite.config.ts`：`/ws` 代理（manifest 由宿主自己同源提供，**不需要** `/wc` 代理）**

```ts
server: { proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } } }
```

**③ 宿主入口（`App.vue` / `main.ts`）：面板 + runtime**

```vue
<script setup lang="ts">
// 面板与 runtime 的接线：建议像 demo 那样拆成一个 <AssistantDock> 组件，在 App.vue 里挂一次
import { getCurrentInstance } from 'vue'
import { useRouter } from 'vue-router'
import { createVueHostRuntimeBinding } from '@webassistant/wc-runtime-vue/host-router'
import { WebAssistant } from '@webassistant/chat-client'

const router = useRouter()
// ★ 给宿主 app：runtime 才能把 context provide 进你的 app（页面里 useRuntimeServices() 才可用）
const app = getCurrentInstance()!.appContext.app

// 宿主能力：**同一份**同时给 runtime 与面板
// ⚠️ 只放纯函数 / 纯数据（传 pinia/i18n 实例会「首次能读、之后不更新」）
const services = {
  getToken: () => authStore.token,
  // ⚠️ 没有「自动采集」开关：runtime 不拦 fetch/XHR。
  //    agent 能看到什么，由宿主在业务代码里显式 apiBus.report() 决定（不调 = 零数据出网）
}

// ★ 一行接线：binding 负责 `base → manifestUrl`（缺省 `{wcBase}/manifest.json`）与 `initial` 转发 ——
//   这两处手写最容易错，且**错了不报错**（只是拿不到页面目录 / initialPage 静默失效）。
//   `createRuntime` 一旦提供，面板的渲染面缺省即推导为 'host'（不必再传 surface）。
const { createRuntime } = createVueHostRuntimeBinding({
  router,                    // 宿主真实 vue-router（绝不 addRoute）
  app,
  services,
})
</script>

<template>
  <div class="shell">
    <header>…宿主自己的导航…</header>
    <router-view />                    <!-- ★ 页面还在这里，原样渲染 -->

    <!-- ★★ 面板必须挂在 <router-view> 之外：挂路由组件里的话，agent 一导航它自己就被卸载 -->
    <div class="wa-dock">
      <WebAssistant ws-base="/ws" :services="services" :create-runtime="createRuntime" />
    </div>
  </div>
</template>
```

> `<WebAssistant :create-runtime>` 是最省事的写法（UI 由库提供）。要**自定义窗口**就用
> `useWebAssistant({ createRuntime, services })` + 自己的组件 —— host 面不需要渲染区，
> 连 `mountEl` 都不用挂（`useRuntimeHost` 只对**容器面**要求它）。
>
> 想自己控制 manifest 地址（CDN / 多环境）就给 binding 传 `manifestUrl`（显式优先）。
> 状态行要展示「谁在驱动这个页面 / 当前页可调用方法」时，headless 层已直接给出
> `navigationSource` 与 `pageExposedKeys`，不必自己 `runtime.on('navigate')` 订阅。

`app` 需要在 `main.ts` 里创建并导出（`export const app = createApp(...)`），或者在 `App.vue` 内创建。

**④ 样式入口 + 内嵌高度（漏了就是「面板样式没引入」）**

```ts
// main.ts
import '@webassistant/chat-client/style.css'   // ★ 库是**预构建产物**：SFC 样式被抽到 dist/style.css，
                                               //   库的 JS 不会自动注入 —— 漏了面板就是一堆裸 HTML
```

```css
/* 面板挂载点：必须把 --wa-height 改成容器的 100%
   （组件根缺省 height: 100vh，塞进 ~620px 的悬浮面板会被 overflow 裁掉底部 → 输入栏看不见） */
.wa-dock {
  width: min(880px, calc(100vw - 48px));
  height: min(620px, calc(100vh - 200px));
  --wa-height: 100%;
  --wa-log-width: 300px; /* 执行监视列宽，缺省 320px */
}

> 这两个变量只服务**内置面板** `<WebAssistant>`：用 `<HostAssistantDock>`（自带尺寸，不受 `--wa-height`
> 影响；改尺寸用 `--wa-dock-width` / `--wa-dock-height`）或 headless 自写 UI 时都不需要它们。
```


### 9.4 开发 / 生产工作流

```bash
# 开发（不需要静态服务器；需要 build:ce 页面才会在容器面板里渲染）
pnpm dev                                  # 宿主自己（含 /ws 代理）
pnpm analyze                              # 生成唯一 manifest（两条渲染面共用）
pnpm dev:agent -- --manifest-url http://localhost:5173/wc/manifest.json
#   或本地文件模式（mtime 热重载，读的是**同一个文件**）：
#   pnpm dev:agent -- --manifest <绝对路径>            ← 最省事
#   ⚠️ 相对路径按**当前工作目录**解析（`pnpm dev:agent` 的 cwd 是 packages/agent-server）
# 浏览器打开宿主 → 说话「打开用户列表」→ 地址栏变 /users，页面在你的 router-view 渲染
```

> ⚠️ 远程（`--manifest-url`）与本地文件（`--manifest`）读的是**同一份 manifest**，只有**失败行为**不同，
> 排查「agent 好像不认识任何页面」时先看这里：**远程**拉取失败只 `warn` 并沿用旧/空 manifest ——
> agent 会静默失明（欢迎语没有能力清单、`render` 无页面可开）；**本地文件**解析/校验失败会让
> agent-server **启动即崩**。生产用远程（宿主不可用时后端照常起），开发用本地（错了就报出来）。
> 另外：宿主自己的 dev server 就够用（manifest 同源），**不需要** `/wc` 代理或额外的静态服务器。

| 部署物 | 用法 A（容器/WC） | 用法 B（宿主直连） |
|---|---|---|
| 宿主 SPA 产物 | ✔ | ✔（页面代码本来就在里面） |
| `dist-ce/`（容器 + 页面 bundle） | ✔ | ✘ |
| `manifest.json`（**同一份**，`public/wc/`） | ✔（同源；8080 那套只是本地验收用） | ✔（同源） |
| 额外静态服务器 / CORS | 需要（承载 `/wc/dist-ce/**`） | ✘ |
| agent-server / `/ws` 反代 | ✔ | ✔（同一条命令） |

### 9.5 能力对照（老项目视角）

| 能力 | 用法 A（WC） | 用法 B（host） |
|---|---|---|
| 页面代码改动 | JS 层面零改动（编译期转 CE） | **零改动**（连编译都不用） |
| 路由参数 | runtime 归一成 props + memory router | 真实 `useRoute().params`（原生） |
| agent 直传 props | element property（对象可用） | 旁路：页面读 `useRuntimeServices().pageProps` |
| `defineExpose` → agent 调用 | 容器读 CE 的 `_instance.exposed` | 读真实实例的 `$.exposed` |
| agent 可调用的方法 | 只 expose「只读 / 视图操作 / 预填」；写后端的方法**不要** expose（见 9.6 第 7 条） | 同左 |
| `defineEmits` → agent | 容器自动捕获 | ⚠️ **不自动捕获**，页面需 `useRuntimeServices().emit(...)` |
| 接口数据 → agent | `apiBus.report()`（调用点显式） | 同左：runtime **零采集**，宿主自己决定报什么 |
| 样式 / UI 库 | 容器内打包 + shadow 隔离 | 宿主自己的，无隔离问题 |
| 登录 / 权限守卫 | 容器内 memory router，不受宿主守卫约束 | 走宿主真实守卫 —— ⚠️ 被拒时 URL 挡住了，但 agent 当前仍拿到 `ok:true`（见 9.6 已知缺口） |
| URL / 刷新 / 分享 | 宿主 URL 不变 | URL 就是当前页 |

### 9.6 五条硬规矩（踩过）

1. **面板挂在 `<router-view>` 之外**（布局外壳 / 悬浮层）。原来的「`/aiassistant` 路由内嵌 `<WebAssistant>`」在用法 B 下不成立：agent 一导航，面板随之卸载。
2. **manifest `name` ↔ 宿主 route `name` 一一对应**（init 告警但不中断；缺名时导航返回 `not-found`）。
3. **单实例**：`apiBus` 是全局单例，同页挂两个 `<WebAssistant>` 会互相抢占（第二个实例会打告警）；两个 runtime 连 `__waRuntime` 调试句柄都会互相顶掉。
4. **agent 导航缺省 `replace`**，不污染用户历史；URL 会跟着变（这是设计意图：URL 与内核双向镜像，URL 为最终裁决）。
5. **你自己那些不在页面目录里的路由照常工作**（登录页 / 404 / 宿主演示页）：它们由桥的
   `passThroughUnknownRoutes`（host 恒开）放行，且**不回流内核** —— 内核保持最后一个目录内页面，
   不为这类跳转广播 `page.navigated`。想「当前页」永远与 URL 一致，就把这些路由也纳入页面目录。
6. **样式入口 + `--wa-height`**：宿主必须 `import '@webassistant/chat-client/style.css'`（库是预构建产物，
   样式不会自动注入 —— 漏了面板就是一堆裸 HTML）；面板挂载点必须给 `--wa-height`（缺省 `100vh`，
   内嵌到 ~620px 的 dock 里会被裁掉底部，表现为「看得见对话、看不见输入框」，见 9.3 ④）。
7. **写入不进执行面**：`call_page_method` 是 agent → 页面唯一的写通道，所以「不让 agent 直接下发数据」的
   正确做法是**不把写后端的方法放进 `defineExpose`**（`save` / `submit` / `delete` 之类），只暴露只读
   （`refresh`）、视图操作（翻页 / 筛选 / 打开详情 / 导航）、预填（打开配置界面并填好参数、但不提交）。
   预填统一返回 `{ ui, open, form }` 快照（demo 的公共件见 `packages/demo-app/src/utils/agentPreset.ts`）；
   用户在页面上点提交后，页面自己的 `apiBus.report()` 会把结果经观测面回给 agent。
8. **一份清单同时驱动两条渲染面**（`openspec/changes/unify-page-manifest`）：host 面**复用**容器模式的
   同一份 manifest，其中的 `containers` / `pages[].bundle` 由 core 归一化为空后忽略。两个后果要知道：
   - 若清单声明了 `container`（容器模式在用），**所有 `tag` 都要含 `-`**（自定义元素规范）；
     否则 `pnpm build:ce` 报错（`pnpm analyze` 会提前警告）。
   - 「某页只在一种模式开放」**无法**用清单表达：`/lab` 这类页面在 host 模式下也在目录内（agent 可打开）。
     也别指望内核守卫能只拦 agent —— `NavigationGuard` 拿不到 `source`，而桥的守卫前移会把
     宿主自己的点击一并送进 `canNavigate`（拦就是两种导航一起拦）。

**已知缺口（`wc-runtime-vue@0.3.0` 保留，待后续批次修）**：**宿主自己的守卫**（你项目 `router.beforeEach`
里返回 `false` / 重定向）拒绝 agent 发起的导航时，真实 URL 会被挡住（这是对的），但**内核状态已经推进到
目标页、agent 的 `navigate()` 仍拿到 `ok:true`**，二者会分裂。原因：vue-router 对被守卫中止的导航是
`resolve` 成 `NavigationFailure`（不 reject），而它在桥里被吞掉了。
**内核守卫**（`runtime.beforeEach`，即 6.4 的「守卫前移」）不受此影响 —— 那种情况返回
`{ ok:false, reason:'aborted' }` 且 URL 不变。绕行办法：把「这个账号能不能去这一页」的判断写成
`runtime.beforeEach`（内核守卫），而不是只写在宿主守卫里。

### 9.7 验收清单（对着自己的项目跑一遍）

- [ ] agent「打开 XX 页面」→ URL 变化 + 你自己的 `<router-view>` 渲染该页面 + 面板仍在
- [ ] 用户点自己的导航 / 浏览器后退 → agent 侧收到 `page.navigated`（source=`host`）
- [ ] `call_page_method` 调用到真实组件的 `defineExpose` 方法（返回值 / 异常都能回给 agent）- [ ] 写后端的方法（`save` 等）**不在** `$.exposed` 里：agent 硬调返回
      `{ ok:false, error:'方法 xxx 未暴露' }`，只能走「预填 + 用户确认」（见 9.6 第 7 条）

- [ ] 页面接口数据能被 agent 看到（在调用点显式 `apiBus.report()`；不调 = 一条都没有）
- [ ] manifest `name` 写错 → init 告警一次列出缺失名（不中断）；agent 导航返回
      `{ ok:false, reason:'not-found' }`，URL 与内核当前页都不变
- [ ] 内核守卫（`runtime.beforeEach`）拒绝某路由 → agent 导航返回 `{ ok:false, reason:'aborted' }`，URL 不变
- [ ] 宿主**自己的**守卫拒绝某路由 → URL 不变（已知缺口：agent 当前仍拿 `ok:true`，见 9.6）
- [ ] 点你自己的**非页面路由**（登录页 / 404 / 关于页）→ 能进去且没有被 runtime 挡住（见 9.6 第 5 条）
- [ ] 首屏就停在某个页面路由上 → agent 第一轮对话就知道「用户当前在哪一页」（adopt，`source: initial`）
- [ ] 与容器模式共用的清单里所有 `tag` 都含 `-`（否则 `build:ce` 报错；`pnpm analyze` 会警告）
- [ ] 面板顶部状态行显示「导航来源」（`navigationSource`）与当前页 `expose` 个数（`pageExposedKeys`）——
      两项由 headless 层直出，不需要自己订阅 runtime

### 9.8 开箱即用的悬浮窗：`<HostAssistantDock>` ★

前面 9.3 给的是「用库的标准面板 `WebAssistant` 自己接线」；如果你要的是 demo 里那种
**右下角悬浮窗**（头部 + 状态行 + 对话 + 「本轮动作」时间线、可收起、页面在宿主自己的位置渲染），
直接用库导出的组件 —— **只需一个 `createRuntime`**：

```vue
<script setup lang="ts">
import { getCurrentInstance } from 'vue'
import { useRouter } from 'vue-router'
import { createVueHostRuntimeBinding } from '@webassistant/wc-runtime-vue/host-router'
import { HostAssistantDock } from '@webassistant/chat-client'

const router = useRouter()
const app = getCurrentInstance()!.appContext.app
const services = { getToken: () => authStore.token }        // 纯函数 / 纯数据

const { createRuntime } = createVueHostRuntimeBinding({ router, app, services })
</script>

<template>
  <div class="shell">
    <header>…宿主自己的导航…</header>
    <router-view />

    <!-- ★ 挂在 <router-view> 之外（挂在路由组件里会被 agent 导航卸载） -->
    <HostAssistantDock
      :create-runtime="createRuntime"
      :services="services"
      title="站点助手"
      badge="AI"
      placeholder="描述你想做什么…"
      :suggestions="['打开用户列表，找一下李四', '看看订单']"
    />
  </div>
</template>
```

它替你做完了：socket 连接与重连、对话状态机、runtime 初始化、页面事件/上报转发、
状态行（连接 / 导航来源 / runtime / 当前页 expose）、「本轮动作」时间线、收起展开。

| 你想改的 | 怎么做 |
|---|---|
| 文案与空态 | props：`title` / `badge` / `placeholder` / `suggestions` / `helloTitle` / `helloHint`（`suggestions` 缺省从页面目录推「打开『XX』」；传 `[]` 关掉） |
| 尺寸与位置 | CSS 变量 `--wa-dock-width` / `--wa-dock-height` + prop `placement`（`bottom-right` / `bottom-left`） |
| 配色 | 覆盖 `--wa-*` token（同 9.3 ④；dock 额外用到 `--wa-panel-bg` / `--wa-text-muted` / `--wa-border-strong` 等，都有缺省值） |
| 接宿主自己的东西 | prop `onRuntimeReady(runtime)`（demo 就在这里接 store 快照桥与调试句柄） |
| 只要一部分 / 自己排版 | 导出 `HostAssistantChat`（对话区）+ `HostAssistantActivities`（本轮动作）—— 都是「数据进、事件出」；或退回 headless `useWebAssistant()` |
| 状态行加自己的指标 | `#status` 具名插槽（追加 chip） |

> ⚠️ 两个已知约定：① **收起用的是 `v-show`**，所以 runtime 与 socket 继续存活 —— agent 仍能导航、
> 会话不丢（别用 `v-if` 包它）；② 单实例（`apiBus` 是全局单例），一页只挂一个 dock。

