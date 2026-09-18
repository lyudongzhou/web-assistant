# demo-app —— WebAssistant 的展示应用

一个「正规的运营后台」：**页面是干净的业务页，平台能力按页面成体系地演示**。
所有验收探针集中在 `/lab`（能力验收室），业务页里不再出现调试条、探针、内联样式。

> 三条链路仍然都在这一个 SPA 里（一个 dev server 5173）：用法 B（宿主直连）/ 用法 A（容器 WC）/
> runtime 层验收台（`wc-demo.html`）。平台设计见根目录 [PROJECT.md](../../PROJECT.md)，
> 接入清单见 [docs/INTEGRATION_GUIDE.md](../../docs/INTEGRATION_GUIDE.md)。

## 1. 跑起来（三个终端）

```bash
pnpm install
pnpm build:libs                 # protocol / core / vue / plugin / analyzer / chat-client

# ① mock 后端 + 静态预览（8080）—— 页面数据都来自这里，不跑它业务页会显示「加载失败」
pnpm preview:ce

# ② 宿主 SPA（5173）
pnpm dev                        # → http://localhost:5173/#/dashboard

# ③ agent 后端（3000）
pnpm dev:agent -- --manifest-url http://localhost:5173/wc/manifest.json
# 或在 packages/agent-server/.env 里配 MANIFEST_URL（同上），直接 pnpm dev:agent

# 用法 A（容器 / WC）另需先生成清单与产物（**清单与 manifest 和用法 B 共用**）：
pnpm analyze                    # → public/wc/manifest.json（AI 不可用时自动回退静态解析）
pnpm build:ce                   # → dist-ce/（容器 + 页面 bundle；只有用法 A 需要）
```

> 两条用法读**同一份** `wc.pages.json` → **同一份** `public/wc/manifest.json`；
> 命令只有 `analyze` + `build:ce`（见 `openspec/changes/unify-page-manifest`）。

打开 `http://localhost:5173/#/dashboard`，右下角悬浮面板就是助手；浏览器地址栏会随 agent 的导航真实变化。

## 2. 页面 ↔ 能力映射（本 demo 的目录学）

| 路由 | 页面 | 演示的能力 |
|---|---|---|
| `/dashboard` | `pages/Dashboard.vue` | 观测面（调用点挑字段上报）、`call_page_method`（`refresh` / `setKeyword` / `openStat`）、`emit` 通知面 |
| `/users` | `pages/UserList.vue` | 控制面 props（`keyword`）、观测面 **+ dataSources 白名单裁剪**、`defineExpose`（`refresh` / `setKeyword` / `setPage` / `nextPage` / `prevPage` / `openDetail` / `openCreateDialog`）、多事件 `emit` |
| `/users/:id` | `pages/UserDetail.vue` | 路由参数 → props、直传 props 旁路（`pageProps.user`）、**agent 只填不交**（`fillEditForm` 预填资料，`save` 未 expose） |
| `/orders` | `pages/OrderList.vue` | 跨页链路（`userId` 从用户页带过来）、`pageProps` 旁路、`setStatus` / `refresh` / `openDetail` |
| `/datasources` | `pages/DatasourceAdmin.vue` | **跨文件自定义类型**（analyzer 类型展开）、**页面级 rules**、宿主 store 镜像、token → 请求头、`openCreateDialog`（打开弹窗+预填，不落库） |
| `/settings` | `pages/Settings.vue` | **登录守卫 + 401**、`services.t`（i18n 宏）、store 镜像、需要 Authorization 的接口 |
| `/login` | `pages/Login.vue` | 宿主自己的路由（**不在 manifest**，agent 看不到）；token 写入宿主 store；**不上报**（凭证不出网） |
| `/lab` | `pages/Lab.vue` | 能力验收室：runtime/apiBus 状态、EP 浮层样式、CSS-in-JS 注入（styleShim）、3D 力导向图 |
| `/assistant` | `pages/AssistantWc.vue` | 用法 A（容器 / WC）：页面在面板内渲染、宿主 URL 不变 |

契约（host 模式硬约束）：路由的 `name` 必须与 manifest 页面的 `name` 逐字相同；
`/login`、`/lab`、`/assistant` 不在 manifest 里，由桥的 passThrough 放行。

### 2.1 「agent 只填不交」：执行面的边界

agent → 页面的写通道**只有** `call_page_method`（调页面 `defineExpose` 暴露的方法），所以「不让 agent 直接
下发数据」的落地方式很直接：**不把写后端的方法暴露出去**。本 demo 六个页面统一只 expose 三类方法：

| 类别 | 例子 | 说明 |
|---|---|---|
| 只读 | `refresh()` | 重新取数并上报，不发写请求 |
| 视图操作 | `setPage` / `nextPage` / `prevPage` / `setStatus` / `setKeyword` / `openDetail` / `openStat` / `backToList` | 只改页面自身的展示与筛选，**不落库** |
| 预填 | `openCreateDialog` / `fillEditForm` / `fillSettingsForm` | 打开配置界面并填好参数，**不提交** |

`save` / `submitCreate` / `onSubmit` / `deleteUser` 这类写后端的方法一律**不进** `defineExpose`：agent 硬调
也只会拿到 `{ ok:false, error:'方法 xxx 未在页面暴露' }`。预填方法统一返回 `{ ui, open, form }` 快照
（`src/utils/agentPreset.ts`），页面同时显示「助手已预填，请确认后提交」；用户点提交后，页面自己的
`reportData` 会把结果经**观测面**回给 agent —— **agent 不写，但看得见写的结果**。

## 3. 数据上报口径（本 demo 的规矩）

runtime **零采集**（不拦 fetch / XHR）。agent 能看到什么，完全由调用点决定：

```ts
// src/api/users.ts —— 原始响应直接上报，边界交给清单声明
const users = await http<User[]>(url)
reportData('user-list', users, { url })      // ← 带 url：命中 dataSources 才裁剪
```

| 写法 | 效果 | 例子 |
|---|---|---|
| `reportData(source, data, { url })` | 命中该页 manifest 的 `dataSources` → 按 `fields`/`maxRows`/`mask` 摘要后才出网 | `/api/users` 12 条 → agent 只看到 6 条、且不含 email |
| `reportData(source, data)`（不带 url） | 原样透传（调用点已自己挑过字段） | `user-detail` 只报 `{id,name,role}`；错误载荷也不带 url（否则会被字段白名单裁空） |
| 不调用 | 零数据出浏览器 | `Login.vue` / `whoami` |

`dataSources` 的单一来源是清单（`wc.pages.json` —— 两条渲染面共用同一份），由 analyzer 原样写进 manifest：

```jsonc
"dataSources": [
  { "match": "/api/users", "fields": ["id","name","role"], "maxRows": 6,
    "primaryKey": "id", "description": "用户列表（最多 6 行；邮箱不出网）" }
]
```

命中后 `source` 会变成 `match` 值（prompt 里显示 `/api/users`）——这是预期的：
「声明命中」优先于调用点自起的名字。**声明 ≠ 自动上报**，runtime 仍然不采集。

## 4. mock 后端（`serve.mjs`，8080）

| 端点 | 说明 |
|---|---|
| `POST /api/login` · `GET /api/whoami` | 登录（写宿主 store）· 回显 `Authorization` |
| `GET /api/users?keyword=` · `GET/PUT/DELETE /api/users/:id` · `POST /api/users` | 12 条演示用户（故意多于 `maxRows=6`） |
| `GET /api/orders?status=` · `GET /api/orders/:id` | 10 条订单，`userId` 与用户表对得上 |
| `GET /api/stats/overview` | 工作台指标 + 近 7 日趋势 |
| `GET /api/datasources` · `POST /api/datasources` | 5 条数据源 |
| `GET/PUT /api/settings` | **需要 `Authorization`**（演示 401 → 登录 → token 链路） |

**错误注入**：任何 `/api` 请求加 `?fail=500` / `?fail=401` / `?fail=slow` 即触发
（页面上有「模拟接口失败」按钮）。失败也会被显式上报（`*-error` 源），所以 agent 知道「数据取不到」，
而不是一直等。

## 5. 两条用法的差异（同一份页面代码）

| 面 | 用法 B（host，默认：业务路由 + 悬浮 dock） | 用法 A（container，`/assistant`） |
|---|---|---|
| 页面渲染位置 | 宿主自己的 `<router-view>` | 面板内渲染区（容器 shadow root） |
| 路由参数 | 真实 `useRoute().params` | 面板内 memory router |
| agent 直传 props | 声明 props 走 `pageProps` 旁路 | element property |
| `defineExpose` | 读宿主路由实例的 `$.exposed` | 容器读 CE 实例 |
| `defineEmits` | ⚠️ **不自动捕获** → 页面里额外调 `ctx.emit()`（本 demo 两种都写了） | 容器自动捕获 |
| 接口数据 | `reportData`（同左） | `reportData`（同左） |
| 宿主 store | 同一个 pinia 实例 | 走**快照镜像**（`createHostStorePusher` + `createStoreMirror`） |
| 样式 / UI 库 | 宿主自己的 | 容器内打包 + shadow 隔离（`tokens.css` 也注入一份） |
| 助手窗口 | 库导出的 `<HostAssistantDock>`（悬浮窗）+ `components/AssistantDock.vue` 薄封装（只补 demo 私货） | 内置 `<WebAssistant>`（对话 + 渲染区 + 执行监视三列） |

> host 模式的窗口来自库里：**没有渲染区**（页面在宿主自己的位置渲染），只有「头部 + 状态行 + 对话 + 本轮动作」
> 一条列。demo 只在 `components/AssistantDock.vue` 做薄封装 —— `createVueHostRuntimeBinding` 造 runtime、
> 宿主 store 快照桥、`__waHostRuntime` 控制台句柄；其余（socket / 对话 / 状态行 / 本轮动作 / 收起展开）
> 都在 `<HostAssistantDock>` 里。内置组件只在 `/assistant`（容器）用。

## 6. 验收清单（对着自己的项目跑一遍）

1. `pnpm dev` + `pnpm preview:ce` 都起来后打开 `/#/users` —— 表格有 12 条数据（不是「加载失败」）。
2. 浏览器控制台：`globalThis['webassistant.apiBus'].listener` 非空（有 runtime 在监听）；
   `apiBus.report({source:'smoke',data:{ok:1}})` 返回 `true`。
3. 助手窗口「本轮动作」里出现 `data · /api/users` 行；点它展开看 args —— 只有 6 行、且没有 email（白名单生效）。
4. 对 agent 说「打开用户管理，找一下李四」→ 地址栏变 `#/users`，表格出现；agent 能引用 `id`。
5. 说「打开李四的详情」→ 地址栏变 `#/users/2`（跨页取 id）。
6. 说「看看这个用户的订单」→ 打开 `/orders` 且带 `userId` 过滤（`pageProps` 旁路）。
7. 说「把站点名字改成 XX」→ 触发登录守卫 → `/login`，登录后回到 `/settings`，**助手把设置表单预填好并提示
   「助手已预填，请确认后提交」**；你点「保存」才生效（token 进了请求头；`/api/settings` 不再是 401）。
8. 点 `/users` 的「模拟接口失败」→ 页面显示错误、助手窗口「本轮动作」出现 `data · user-list-error`。
9. 切「站点设置」的语言为 English → 页面文案跟着变（`services.t`）。
10. 打开 `/lab` → 状态卡显示 apiBus 已挂载、当前页 tag、expose 清单；浮层下拉菜单是高亮样式
    （非 scoped 样式命中）；3D 图可拖拽。
11. 说「看看用户列表下一页」→ agent 调 `nextPage()`，表格翻页，`tool.result` 带
    `{ page, pageCount, rowCount }`（agent 据此自己判断还有没有下一页）。
12. 说「直接帮我把站点名保存成 XX」→ agent **没有写通道**：最多把表单预填好并请你确认（若模型硬调 `save`，
    助手窗口「本轮动作」里该次 call 的 result 是 `{ ok:false, error:'方法 save 未在 site-settings 暴露' }`）。
13. 打开 `/assistant` → 面板内渲染容器批次页面（先跑 `pnpm analyze` + `pnpm build:ce`）；
    同一份 `UserList.vue` 在面板里也能用（store 镜像是镜像值）。

## 7. 已知缺口 / 注意事项

- **host 模式的 emit**：页面用 `defineEmits` 触发的事件在 host 模式**不会**自动到 agent，
  必须额外 `useRuntimeServices().emit()`（本 demo 在 UserList / UserDetail 两种都调了，便于对照）。
- **守卫被拒时**：`/settings` 未登录会被守卫拦下（URL 不变），但 agent 侧仍收到导航 `ok:true`
  —— 已知缺口，见 PROJECT.md 6.9。
- **manifest 的 keywords / exampleQueries 需要 AI 分析**（`pnpm analyze` 读 `packages/demo-app/.env`
  的 DeepSeek 配置）；余额不足时会自动回退静态解析（`@description` 注释 → description，keywords 为空），
  功能不受影响。
- **`/lab` 不进 manifest**：它是人工验收室，agent 看不到、也不会被导航过去。
- **单 runtime 约束**：同一页只允许一个 runtime（apiBus / activityBus 是全局单例）——
  `/assistant` 里会隐藏悬浮 dock，见 `App.vue` 与 `components/AssistantDock.vue`。
