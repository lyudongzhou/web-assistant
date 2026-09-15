# WebAssistant 项目文档

## 一、项目简介

一个「对话式 Web 助手」：把现有项目（Vue3 + vue-router）的路由页面编译成 **Web Component**，
分析页面功能生成描述清单（含 AI 生成的 keywords/exampleQueries），供 **agent 后端** 理解；
前端与 agent 对话，agent 通过 **SSE** 推送用户需要的页面并在前端渲染。

核心链路：

```
现有项目页面 ──JSON 驱动构建──▶ Web Component ──分析（静态 + AI）──▶ manifest.json
                                                              │ 喂给
用户对话 ──▶ agent 后端（LLM 决策）──SSE──▶ 前端（client 组件）渲染对应页面
```

## 二、核心思想

1. **页面即资源**：把路由页面变成可独立加载、按需渲染的 Web Component。
2. **agent 决策**：用户用自然语言描述需求，agent 理解后决定「渲染哪个页面」。
3. **运行时容器**：样式隔离、组件库（element-plus）、路由等「应用级上下文」统一收口到
   一个运行时容器（runtime-wc），业务页面不重复打包、不自己隔离。
4. **client 是组件**：整个对话+渲染客户端封装成 `WebAssistant` 组件，可被宿主项目
   （如 ontology）import 并内嵌到某个路由，而不是反过来「在 client 里看宿主」。
5. **wc.pages.json 是唯一真相来源**：构建插件和 analyzer 都读它，一份配置驱动「打包 + 分析」。

## 三、架构总览

```
宿主项目（如 ontology）
  ├── vite.ce.config（复用宿主插件 + wc 插件 + wcManifestPlugin）──▶ dist-ce/ + manifest.json
  ├── wc.pages.json ──▶ analyzer（静态 + AI）──▶ manifest.json
  └── /aiassistant 路由内嵌 <WebAssistant>  ──┐
                                                │ 加载 manifest + dist-ce、请求 agent
┌───────────────────────────────────────────────▼──────────────────────────────┐
│ WebAssistant（client 组件）                                                    │
│   对话窗口（ChatPanel）          渲染区域（runtime-wc 按 tag 渲染业务 WC）        │
└──────┬──────────────────────────────────────────┬────────────────────────────┘
       │ POST /chat（SSE text/render/done）         │
┌──────▼──────────────────────────────────────────┴────────────────────────────┐
│ agent-server（Cline SDK + DeepSeek）                                            │
│   --manifest <path> 加载清单 → ReAct 循环 → go_to_page 工具 → SSE 输出           │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 四、包结构与职责

```
webassistant/
├── package.json              # pnpm workspace 根
├── pnpm-workspace.yaml       # 含 overrides（统一 @types/node，避免 vite 多实例）
├── tsconfig.base.json        # 全仓 TS 基线：strict + verbatimModuleSyntax + noUnused*
└── packages/
    ├── protocol/             # @webassistant/protocol：跨包契约（纯类型 + 命名工具，零依赖）
    │   └── src/
    │       ├── wcPages.ts       # wc.pages.json v2 schema + tag/产物路径命名规则（单一来源）
    │       ├── manifest.ts      # manifest v2（analyzer 写 / runtime 读 / agent 读）
    │       ├── sse.ts           # AgentEvent 可辨识联合（text/render/done/error）
    │       └── pageEvent.ts     # 页面 emit 回传载荷
    │
    ├── vite-plugin-wc/       # @webassistant/vite-plugin-wc：JSON 驱动的 WC 构建插件（TS）
    │   └── src/
    │       ├── index.ts         # wcVuePlugin（customElement 编译所有 .vue）+ wcBuildPlugin（多入口 + 样式聚合）
    │       ├── config.ts        # 读 + 校验 wc.pages.json
    │       ├── entries.ts       # 生成页面入口（definePage 契约）
    │       └── resolve.ts       # 别名 / 裸包 / 路径解析
    │
    ├── wc-runtime-core/      # @webassistant/wc-runtime-core：框架无关「定义层」（不对外，见 6.8）
    │   └── src/
    │       ├── types.ts          # 契约本体：Route/View/Services/Adapter/Navigation/Events
    │       ├── manifest.ts       # manifest v2 归一化 + 校验
    │       ├── navigation.ts     # 当前页面的唯一真相源（三索引寻址/history/guard/source）
    │       ├── loader.ts         # 容器/页面 bundle 动态 import（去重 + 失败降级）
    │       ├── containers.ts     # 按 framework 懒建容器 + 跨框架切换（keep/unmount）
    │       ├── services.ts       # 外层依赖的稳定引用 + 「框架无关」校验告警
    │       ├── state.ts          # 宿主业务状态的单向快照桥
    │       ├── styles.ts         # base→shared→page 分层 + 去重 + append-only
    │       ├── props.ts          # params/agentProps → 归一后的元素 props
    │       ├── events.ts / dom.ts / runtime.ts   # 事件总线 / DOM 工具 / 编排门面
    │       └── (test/)           # node --test，66 例，零额外依赖
    │
    ├── wc-runtime-vue/       # @webassistant/wc-runtime-vue：Vue 实现 + **唯一对外门面**
    │   └── src/
    │       ├── container.ts      # defineVueContainer：<runtime-vue> 容器（隔离边界 + 依赖注入点）
    │       ├── definePage.ts     # definePage：页面组件 → 业务 WC（shadowRoot:false）
    │       ├── vueRouterBridge.ts# memory vue-router ↔ core 双向同步（路由表/guard 前移/防回环）
    │       ├── context.ts        # services/state/nav 注入 + useRuntimeServices + $tt
    │       └── index.ts          # createVueRuntime（宿主入口）
    │
    ├── demo-app/             # 示例「老项目」：Vue3 + vue-router + element-plus（已全量 TS）
    │   ├── vite.config.ts        # SPA 模式（普通 Vue app，验证页面功能）
    │   ├── vite.ce.config.ts     # WC 构建（wcVuePlugin + wcBuildPlugin；不含 wcManifestPlugin，manifest 分析独立）
    │   ├── wc.pages.json         # v2：framework + container + pages（构建与分析共用）
    │   ├── wc-demo.html          # ★ runtime 验收台：直接 import core 的 dist，零构建端到端验证
    │   ├── serve.mjs             # 静态服务器（预览 WC 产物）
    │   ├── manifest.json         # manifest v2（由独立 wc-analyze 生成；build:ce 不负责分析）
    │   └── src/
    │       ├── pages/*.vue       # 页面（<script setup lang="ts">，defineProps 保留运行时对象写法）
    │       ├── ce/container.ts   # ★ 批次容器入口（defineVueContainer：element-plus + setup 钩子）
    │       ├── utils/request.ts  # 批次共享请求单例（宿主注入的实例由容器 setup 接管）
    │       ├── data.ts           # 共享 mock 数据
    │       ├── router/index.ts   # SPA 路由表
    │       └── main.ts           # SPA 入口
    │
    ├── analyzer/             # @webassistant/analyzer：读 wc.pages.json + 页面源码 → manifest v2（TS）
    │   └── src/
    │       ├── index.ts          # CLI：wc-analyze --config <wc.pages.json> [--out] [--tsconfig] [--env-file] [--ai-cache] [--no-ai]
    │       ├── analyze.ts         # 组装 manifest v2（命名规则来自 protocol）
    │       ├── rules.ts           # 规则收集：wc.pages.json 的 rules 声明 → manifest.rules（analyzer 与插件共用）
    │       ├── parseComponent.ts  # @vue/compiler-sfc 切块 + babel(typescript) 解析 props/emits/描述
    │       ├── typeResolver.ts    # vue-tsc 内核：跨文件类型解析，签名里的自定义类型展开成字段结构
    │       └── ai.ts              # AI 语义分析（DeepSeek → description/keywords/exampleQueries，缓存+兜底）
    │
    ├── agent-server/         # Agent 后端：Cline SDK + DeepSeek
    │   └── src/
    │       ├── index.js          # HTTP：POST /chat(SSE)、POST /event、GET /health；支持 --manifest/--port CLI
    │       ├── agent.js          # ReAct 循环（Agent + go_to_page 工具 + subscribe 事件）
    │       ├── tools.js          # createTool 定义 go_to_page
    │       └── manifest.js       # 加载 manifest + 拼 system prompt（含 keywords/exampleQueries）
    │
    └── chat-client/          # 前端客户端（组件库：可被宿主 import，已全量 TS）
        ├── vite.config.ts        # SPA demo（proxy /wc→8080、/api→3000）
        ├── vite.lib.config.ts    # 库构建（external vue；core 无框架依赖，打进库里）
        └── src/
            ├── index.ts          # 导出 WebAssistant / WelcomePage / useWelcomePage / mountWebAssistant / 纯逻辑 / 类型
            ├── WebAssistant.vue  # 主组件：只做布局与接线（渲染区无页面时展示欢迎页，可被宿主覆盖）
            ├── components/ChatPanel.vue
            ├── components/WelcomePage.vue # 内置欢迎页（默认呈现组件）：text + 能力卡片（#welcome 插槽 / welcome prop 可覆盖）
            ├── composables/
            │   ├── useRuntimeHost.ts # ★ createHostRuntime + 生命周期，包成响应式状态（view.tag → hasPage/currentTag）
            │   ├── useAgentChat.ts   # ★ 对话状态机（流式拼接 + render 回调 + 欢迎载荷/握手就绪）
            │   └── useWelcomePage.ts # ★ 欢迎页状态机（空态判定 / 文案 / 能力清单 / 加载态）
            ├── lib/welcome.ts    # 欢迎页纯逻辑（零依赖、可单测）：默认文案 + variant/loading/合并
            ├── lib/initialPage.ts# 首屏是否自动打开页面的归一化（缺省不打开 → 先出欢迎页）
            ├── lib/agentSocket.ts# 类型化 WS 客户端（session / 重连退避 / 心跳 / RPC）
            └── types.ts          # Props / Emits / ChatMessage / 欢迎页类型 / 主题变量
```

## 五、核心数据流

### 5.1 agent 对话渲染页面

```
用户输入「我想看订单管理」
  → useAgentChat 发 POST {agentBase}/chat { message }
  → agent-server（DeepSeek ReAct）决策 → 调用 go_to_page('order-list')
  → SSE 流式输出：event: text / render / done
  → onRender → runtime.navigate({ tag:'order-list', source:'agent', replace:true })
  → core：ensure 容器 → ensure 页面 bundle → 计算 view → patchContainer
  → <runtime-vue> 渲染 <order-list>，'navigate' 事件回层更新标题与返回按钮
```

### 5.2 页面内 router 导航（老代码一行不改）

```
列表页点「详情」→ useRouter().push({ name:'UserDetail', params:{ id } })
  → 容器内建 memory vue-router：beforeEach → core.canNavigate（guard 前移）
                                afterEach  → core.commit（source='page'，不回推，防回环）
  → core 计算 props（params 按 manifest type 归一）→ patchContainer → 渲染 <user-detail :id="4">
```

### 5.3 页面事件（emit）

```
翻页/搜索/删除 → 页面 emit → Vue CE 派发 CustomEvent（composed:false，停在容器 shadow root 内）
  → 容器按 view.events 挂的监听 → runtime 'page-event' → WebAssistant emit('page-event')
  → 宿主自行处理；forwardPageEvents=true 时再 POST {agentBase}/event 告知 agent
```

## 六、关键技术设计

### 6.1 WC 构建（vite-plugin-wc，JSON 驱动）

- `wc.pages.json`（v2）是唯一真相来源，一个文件描述**一个 framework 批次**：
  ```json
  { "framework": "vue", "container": "src/ce/container.ts",
    "pages": [ { "name": "DataSource", "tag": "data-source", "path": "/datasource",
                 "title": "数据源管理", "component": "#/views/datasource/index.vue" } ] }
  ```
- `wcVuePlugin()`：`customElement` 过滤 = 项目内所有 `.vue`（排除 node_modules）→ 页面与共享组件的
  `<style>` 一律内联成 `.styles`（不再抽出 `shared.css`）。
- `wcBuildPlugin()`：为每个页面生成入口（`export const styles = [...Page.styles, ...共享组件样式]` +
  `export default (api) => definePage(Page, api)`），并把「页面依赖树里共享组件的样式」聚合进该页面的
  `styles` 导出（页面自身样式在前，共享组件样式在后，按 owner 排序去重）；容器入口直接指向 `container`
  文件；产物 `containers/<framework>.js` + `pages/<camelTag>.js`，`external: []`。
- 产物命名（tag / bundle 路径 / 容器标签）由 `@webassistant/protocol` 统一提供，analyzer 与 core 共用同一套函数。
- 路径解析支持：相对路径、别名（读 package.json `imports` 或 `options.aliases`，如 `#/`）、裸包名。
- Vite library 模式不支持「虚拟模块/包名」作 entry，故页面入口写成真实文件（缓存到 `node_modules/.wc-entry/`）。

### 6.2 运行时容器 <runtime-vue>（wc-runtime-vue/container.ts）

- 每个 framework 一个容器 WC，它自己的 shadow root 是**唤一隔离边界**；容器 bundle 自带框架与 UI 库。
- 容器接收的固定属性（由 core 的 `RuntimeView` 下发，全部走 DOM property）：
  `tag / pageProps / pageStyles / stylesVersion / status / error / events`。
- 业务 WC 用 `shadowRoot: false`，渲染在容器 shadow root 内，共享容器注入的 UI 库样式。
- 样式分层：`base`（UI 库，可走 `adoptedStyleSheets` 跟容器共享同一张构造样式表）→ `shared`（manifest 声明）
  → `page`（页面 `styles`，append-only）；`:root` 自动重写为 `:host`。
- **光 DOM CSS 注入**：UI 库浮层（el-select 下拉 / tooltip / dialog）teleport 到 body，跑出 shadow 边界 ——
  这是隔离方案的**已知泄漏点**，分两层补：`lightDomStyles`（UI 库基座）+ 页面/共享组件样式在
  `patchContainer` 时经 `injectLightDomStylesBulk` 自动补一份进光 DOM（内容哈希去重、append-only）。
  ⚠️ 注意：页面 `<style scoped>` 的 `:deep()` 只对「页面自己模板里 teleport 的内容」生效；像
  `el-dialog` 这种**子组件内部** teleport 到 body 的节点不会带页面的 `data-v-xxx`，`:deep(.el-dialog__title)`
  命中不了。定制浮层请用 `dialog-class`/`popper-class` + 非 scoped 的 `<style>` 块。
- **反向补齐（document → shadow）**：CSS-in-JS / UI 依赖在运行时 `document.head.appendChild(<style>)`
  注入样式，这些样式在 document 树里、**匹配不到 shadow 树**，WC 里就不生效。由 `styleSink.ts`
  兜：容器 `mountContainer` 把自己的 shadow root 登记为「样式收件人」
  （`addStyleTarget`，状态在 `globalThis` + `Symbol.for`，跨 bundle 唯一）；
  `vite-plugin-wc` 的 `styleShim.packages` 会把**指定包**的模块前置成
  `var document = …shadowDocument(globalThis.document)` —— 包内裸 `document` 的 `<style>/<link>` 插入
  被**改道**：真节点直接移进注册表里的 shadow root（不再往 head 放、也不再克隆），
  样式归容器所有 → 容器卸载即随元素销毁；切页按「页级 scope」摘下 / 挂回（ESM 只求值一次，不能真销毁）。
  模块级 transform 让 Rollup 把该绑定改名成 `document$N`，所以遮蔽范围**只收敛在被指定包内**。
  已知缺口：`window.document` 等全局属性路径、未列入 `packages` 的子依赖、多容器（见 vite-plugin-wc README 6.2）。

### 6.3 路由：单一真相源 + 两条入口

- core 的 `NavigationController` 是「当前页面」的唤一真相源（tag / name / path 三种寻址，
  history 支持 back/forward/go(n) 与 canGoBack/canGoForward，导航带 `source`）。
- agent：`runtime.navigate({ tag, params, source:'agent', replace:true })`。
- 页面内老代码：`useRouter().push({ name, params })` → 容器内建 memory vue-router → RouterBridge → core。
- 宿主不再需要自己维护 historyStack（旧 PageHost 的 hack 已删）。

> ⚠️ 唯一例外：**宿主直连模式（用法 B，见 6.9）下真实 URL 是最终裁决** —— 用户能改地址栏 / 浏览器后退，
> 内核无法拒绝。因此那里的语义是「URL 与内核**双向镜像**」，而不是内核独占真相。

### 6.4 vue-router 桥的三个机制（wc-runtime-vue/vueRouterBridge.ts）

| 机制 | 做法 | 为何必须 |
|---|---|---|
| 路由表同步 | core routes → `addRoute`，组件是哑组件 `{ render: () => null }` | `push({ name })` 要求 name 存在；真正的渲染由容器按 `tag` 负责，**不走 `<router-view>`** |
| guard 前移 | core 的 guard 挂进 `beforeEach`，拒绝时返回 `false` | 否则页面 `push` 一定「成功」而 core 却拒绝，两边状态分裂 |
| 防回环 | `applying` **计数器**（不是布尔），`afterEach` 见 `applying>0` 就跳过 commit | vue-router 导航是异步的，布尔 flag 会被并发导航打穿 |

单副本前提下（容器与页面同批构建）**不需要**手动桥接 `routerKey` 等 symbol，`app.use(router)` 直接可用。

### 6.5 服务注入（request / t / token / state）

宿主传 `services` → core `ServicesRef`（稳定引用）→ 容器 `app.provide(RUNTIME_CONTEXT_KEY, ctx)`
→ 页面 CE 继承容器 provides（Vue 3.5 `_inheritParentContext`）+ `definePage` 里再 provide 一次兜底。

```ts
// 页面里
const ctx = useRuntimeServices()      // 或 tryUseRuntimeServices()（SPA 里返回 null）
await ctx.request.get('/users')       // ⚠️ 不要解构 request（getter）
ctx.t('key'); ctx.state.user; ctx.nav.push({ tag })
```

- **UI 库 / store 实现**属于「rumtime 自有」：写在批次容器入口的 `plugins`（每个页面 app 都 `app.use`，
  因为全局组件不随 provide 继承）。
- **宿主业务状态**走 `runtime.setState()` 快照单向同步，页面变更用 `ctx.emit()` 回传。
- 批次内的共享单例（axios 拦截器 / dayjs locale）在容器的 `setup(context)` 一次性钩子里配。

### 6.6 $tt 宏（原项目的 i18n 宏，非 $t）

- 原项目用 `$tt('中文')` 而非 `$t(key)`；`$tt` 由原项目自己的 vite 插件（如 `easyAutoI18nPlugin`）
  在构建期把参数 `'中文'` 替换成 md5 hash：`$tt('数据源更新成功')` → `$tt('250880e6')`，
  中文原文写进 `*_autogenerate.json`。
- 运行时 `$tt` 就是 `services.t`：容器与每个页面 app 都挂 `globalProperties.$tt`，并兜底挂 `window.$tt`（见 6.5）。
- CE 构建必须复用原项目的 i18n 插件；且要**避免其 cleanup 污染主应用的词条文件**——
  把插件的 `localesDir` 指向临时目录、`targetLangs` 置空（主构建负责生成/翻译）。

### 6.7 AI 生成 manifest（analyzer/ai.ts）

- 静态解析（`@vue/compiler-sfc` 切块 + babel，支持 `lang="ts"`）+ AI 语义分析（DeepSeek，openai-compatible fetch）→ `description/keywords/exampleQueries`。
- 按组件源码 hash 缓存（`.analyze-cache.json`，可用 `--ai-cache` 或 API 的 `aiCacheFile` 指定），
  无 key/失败回退静态 `@description`。
- analyzer 不依赖 `agent-server/.env`：CLI 默认读取 `wc.pages.json` 同目录 `.env` / `.env.local`（可用 `--env-file` 指定），
  Library API 默认读取宿主进程 `process.env`。AI 请求失败时回退静态解析，只有成功的 AI 结果才写入 AI 缓存。
- `buildSystemPrompt` 把 `keywords/exampleQueries` 拼进 system prompt，提升页面匹配。

### 6.7.1 跨文件类型解析（analyzer/typeResolver.ts）

- 用 vue-tsc 内核（`@vue/language-core` + `@volar/typescript`）建一次 program，把 `props` / `emits` 载荷 / `exposes` 签名里的自定义类型
  展开成真实字段结构，agent 才知道该传什么：`setFilter(patch: Partial<DatasourceFilter>)` →
  `(patch: { keyword?: string; ... })`。详细决策见 [`docs/analyzer-type-resolution.md`](docs/analyzer-type-resolution.md)。
- 展开规则：项目内类型递归展开；外部**非泛型**（`Record<string, string>`、`AxiosResponse`）只打印名字；
  外部**泛型实例化**（`Promise<T>` / `Set<T>`）保留名字但继续展开类型参数；外部 **mapped 类型**（`Partial<T>` / `Readonly<T>` /
  `Pick` / `Omit`）在类型参数含项目内类型时按对象展开。深度上限 4 + 环检测。
- `node_modules` 里**软链**进来的 workspace 包（如 `@unicom/ontology-api` → `packages/api`）realpath 不在 `node_modules`，按项目内类型展开。
- 类型注解偏移会收敛到「起点相同的最外层类型节点」，避免 `Partial<X>` 退化成 `Partial<T>`、`Foo[]` 丢 `[]`。
- 找不到 `tsconfig.json` / vue 语言插件初始化失败 → 打印 warning 并降级为纯语法解析（自定义类型退化成 `Object`/`Array`），不破坏老宿主。

### 6.7.2 项目规则：wc.pages.json → manifest.rules → prompt

- 被服务项目在 `wc.pages.json` 声明规则文档，**两级**：
  - **manifest 级**（一波页面一波规则）：顶层 `"rules": ["rules/domain.md", "rules/policies"]`
  - **页面级**（只在该页面生效）：页面条目里 `{ "name": "DatasourceAdmin", ..., "rules": ["rules/datasource-page.md"] }`
- 声明值支持：文件路径 / 目录（**自动收集**所有 `.md`，按文件名排序）/ 内联 `{ name, content }`。
- 规则 Markdown 顶部可选 frontmatter（`name` / `disabled`），字段名对齐 Cline SDK 的 `RuleConfig`（为后续接 skill 留口）。
- `analyzer/src/rules.ts`（`resolveRuleEntries`）被 analyzer 与 `wcManifestPlugin` **共用**，把正文内联进
  `manifest.rules: ManifestRule[]` 与 `manifest.pages[].rules`，保证两条生成路径不漂移；未声明时不写字段（避免噪音）。
- `wcManifestPlugin` 的 dev watch 把规则文件/目录纳入监听，改动即增量重生成；未声明但旧 manifest 有对应 `rules` → 保留旧值
  （与 `dataSources` 同款「手工字段保留」策略，页面级同样适用）。
- agent-server：`ManifestService.getRules()` + `buildAgentContext()` 把 manifest 级 `rules` 拼进 system prompt 的
  「项目规则」段（**优先于通用规则**），页面级 `rules` 拼在「可用页面」列表里对应页面条目下（`页面规则（只在该页面生效）`），
  两级均跳过 `disabled`；本地 manifest 走 mtime 热重载 / 远程 manifest 走定期刷新 → 改规则无需重启 agent-server。

### 6.7.3 连接欢迎内容：欢迎语 + 欢迎页（session.ready.welcome / chat.text）

- 每次 WS 连接建立（`session.hello`）后，agent-server 下发欢迎内容，介绍「能做什么」，两条通道：
  - **结构化载荷** `session.ready.welcome = { text, capabilities[] }`：`capabilities` 由
    `ManifestService.buildWelcome()` 从 manifest 页面派生（`tag / name / title / description / examples`，
    examples 取 `exampleQueries` / `keywords`）—— **纯数据、零 LLM 成本**；随握手一并下发，顺序天然正确。
  - **聊天气泡问候** `chat.text` + `chat.done`：内容即 `welcome.text`，用 `setTimeout(0)` 排在 `session.ready` 之后
    （`session.ready` 是 handler 返回值，Nest 在 return 后同步发送）。
- 配置：`WELCOME_MESSAGE` 覆盖 `text`（能力清单不变）；`WELCOME_ENABLED=0` 关闭。

#### 欢迎页 = 渲染区空态（没有渲染子 WC）

**定义**：欢迎页不是独立功能，而是「runtime 当前没有页面」时渲染区的默认内容。判据只有一个 —— runtime 的当前页 tag：
`RuntimeView.tag === null`（新增 `Runtime.hasPage` getter 与之同源，`false` ⇔ 没有渲染任何子 WC）。由此推出的三条约束：

- **「有没有页面」以 runtime 的 `view` 事件为准**（`useRuntimeHost` 订阅后派生 `currentTag` / `hasPage`），
  **不用 `navigate` 事件**：后者只表示「发生过导航」，页面加载失败也不回退，而且一旦导航过就再也回不到空态。
- **页面加载失败 ≠ 无页**：错误独立成横幅展示，不再顶掉欢迎页（旧实现里 `v-if="error"` / `v-else` 让两者互斥，
  错误一出现欢迎页就消失）。横幅**仅无页时显示**：有页面时页面加载失败由容器渲染 `.wa-runtime-error`，
  其余运行时错误走 `error` ref / `@error` emit。
- **首屏默认不自动打开页面**（runtime 原本默认打开 manifest 第一个页面）：chat-client 的 `useRuntimeHost` 显式传
  `initial: null`（见 `lib/initialPage.ts` 的 `resolveInitialTarget`），欢迎页才会先出现；宿主可用 `initialPage`
  （`true` = 第一个页面 / tag 字符串）恢复或指定首屏页面。

**逻辑对使用者开放**（框架自带默认 + 宿主可覆盖；三层，纯逻辑与呈现解耦）：

| 层 | 文件 | 作用 |
|---|---|---|
| 纯逻辑 | `chat-client/lib/welcome.ts` | `DEFAULT_WELCOME_TEXT` + `resolveWelcomeVariant` / `resolveWelcomeLoading` / `resolveWelcomeText` / `resolveWelcomeCapabilities`；零依赖、可单测 |
| 响应式 | `chat-client/composables/useWelcomePage.ts` | 包成 `{ variant, visible, text, capabilities, loading }`；`useWebAssistant()` 以 `welcomePage` 透出 |
| 呈现 | `chat-client/components/WelcomePage.vue` | 默认组件（`text` / `capabilities` / `loading` 三个 prop） |

- `variant`：`page`（有页面，渲染区被页面接管）/ `welcome-loading`（无页 + 数据源都没就绪）/ `welcome`。
- `text` / `capabilities` 已合并：agent 握手下发的载荷优先，**旧服务端未下发时用本地 manifest 路由兜底**
  （只有 `tag`/`name`/`title`），不依赖新协议也能显示欢迎页。
- `loading` 语义 = 「欢迎内容是否仍在等数据源」（握手 `session.ready` / manifest 都没 settle；失败也算 settle）
  —— 不再是「对话中」，因此刷新瞬间不会误显「暂无可操作页面」。
- 覆盖优先级：`WebAssistant` 的 `#welcome` 插槽 > `welcome` prop（`Component | false`）> 内置 `WelcomePage`；
  `welcome=false` 回退最小空态。`#welcome` 插槽入参是**合并后的完整状态**
  （`WelcomePageSlotProps`：`text` / `capabilities` / `loading` / `variant` / `currentTag` + 原始 `welcome` / `routes`），
  模板宿主不必自己判空与合并。
- headless 宿主：`useWebAssistant()` 取 `welcomePage` + 导出的 `WelcomePage`（或自己的组件）渲染；
  `welcome` / `routes` / `currentTag` / `manifestSettled` / `sessionReady` 也一并透出。
- 容器侧另有「批次内空态」（`defineVueContainer({ renderEmpty })`，默认文案「暂无页面」）：它属于**容器 shadow DOM 内部**，
  由被服务项目配置（容器 bundle 自带另一份 vue，宿主的 Vue 组件传不进去）；单框架 + 首屏不导航时容器是懒建的、
  不会触发，宿主级欢迎页不走它。
- 客户端 `useAgentChat` 在 `chat.done`/`chat.error` 后重置流式游标，使 server 主动推送的消息另起一条气泡。

### 6.8.1 wcManifestPlugin：可选的 manifest 增量集成（vite-plugin-wc）

- **分析与构建分离**：`vite build --config vite.ce.config.ts` 只生成 WC bundle，不执行 manifest 分析；单独执行 `pnpm analyze` 生成/更新 manifest.json。
- **分析插件可选**：`wcManifestPlugin` 仍可在需要 Vite watch 集成的项目中显式启用，但不应默认加入纯构建配置。
- **dev**：显式启用 `wcManifestPlugin` 时，监听 `wc.pages.json` 与页面组件源码变化 → 增量重生成 manifest（供 agent-server 热读）。
- **增量策略**：对每个页面算指纹 `sha256(source + path + title + component + framework)`，
  指纹未变且旧 manifest 有条目 → 直接复用旧条目；变化/新增 → 重新静态 + AI 分析。
- **手工字段保留**：旧 manifest 有 `dataSources` 等手工字段且新分析结果没有 → 保留旧值
  （dataSources 含 fields 白名单 / mask 脱敏 / primaryKey 等强约束字段，静态难以推断，保持手工维护）。
- **指纹缓存**：项目根 `.wc-manifest-cache.json`（gitignore）；AI 结果缓存 `.analyze-cache.json`。
- 用法：默认不挂载；只在需要 Vite watch 集成的项目中显式启用：`plugins: [wcVuePlugin(), wcBuildPlugin(), wcManifestPlugin()]`。
  可选参数：`{ configPath, outPath, noAi, cacheFile, aiCacheFile, watch }`。

### 6.8 runtime 分层与依赖二分模型（wc-runtime-core / wc-runtime-vue）

新一代运行时把「运行时容器」拆成两层，替代旧 `wc-runtime`（旧包保留，demo 现仍在用）：

- **`wc-runtime-core`：定义层**，框架无关。契约类型 + manifest/navigation/loader/containers/services/state/
  styles/props/events/view 的编排实现。**不对外**，只被各框架实现衍生。
- **`wc-runtime-vue`：Vue 实现 + 唯一门面**。宿主 `createVueRuntime`、批次入口 `defineVueContainer`、
  页面入口 `definePage`、页面内 `useRuntimeServices`。

**runtime 是独立的 WC 容器，按框架分批**：这批 WC 是 vue → `<runtime-vue>`；那批是 react → `<runtime-react>`。
core 按 `route.framework` 懒建对应容器；每个容器自己的 shadow root 是唯一样式隔离边界（element-plus CSS
不会污染 react 批次，也不会漏到外层宿主）。

**依赖二分**：

| 类型 | 例子 | 何时确定 | 传递机制 | 约束 |
|---|---|---|---|---|
| runtime 自有 | vue、vue-router、element-plus、pinia | 构建期 | **与页面同批构建** → Vite 共享 chunk → 页面相对 URL import → 浏览器按 URL 去重 → 同一实例 | 无 |
| 外层传入 | request、t、token、theme、state | 运行时 | 宿主 → `servicesRef` → 容器 `app.provide` → 页面 CE 继承 | **必须框架无关**（纯函数/纯数据/订阅） |

- 硬约束：**一个 framework 批次 = 一次构建 = 一个产物目录**（容器与页面同 build 才共享框架实例，
  `instanceof VueElement` 才成立，provide 继承才生效）。因此不需要 import map / 构建期 external 重写。
- 外层依赖不能传框架响应式实例（宿主 store/i18n 实例）：跨副本依赖收集不互通 → 页面「首次能读、之后不更新」。
  业务状态走 `runtime.setState()` 快照单向同步，页面变更用 `services.emit` 回传宿主。
- store 两层：**实现**（pinia 实例）写在批次容器入口的 `plugins`，整批页面共享同一 store；
  **数据**（宿主状态）走 `services.state` + `setState` 快照。
- **宿主 pinia ≠ 批次 pinia**（四层隔离，显式契约）：①两个 `createPinia()` 实例；②pinia 库是两份独立
  模块副本（宿主产物 vs `dist-ce/**`）；③`piniaSymbol` 每副本一个，`inject` 只认自己副本的；
  ④模块级 `activePinia` 每副本一份。因此 `hostStore === ceStore` 永远不成立，同名 store id 在两边
  各存一份 → 也让"宿主与批次共享同一个 pinia 实例"在**不共享 vue 副本**时不可能生效
  （pinia 的 ref/computed 由创建它的那份 vue 实现，依赖收集跨副本不互通）。
  - 要让"宿主 store 的数据给页面 store 用"：走 **store 快照桥（镜像）** ——
    宿主 `createHostStorePusher({ getRuntime }).plugin` 挂宿主 pinia（每个 store 创建/变更即推
    `store:<id>` 快照）→ CE 容器 `createStoreMirror().plugin` + `mirror.attach(context)` 按 store id
    hydrate 进批次 pinia。页面代码零改动，仍是**同一份数据、两个 store 对象**。
    边界：只同步可序列化 `$state`（getter/action/对象身份不过桥）；默认单向。
  - 接口依赖宿主 store 里的 token：**不要**传 store，给纯函数 `services.getToken`；
    容器拦截器每次请求现读 `context.services.getToken?.()`（捕获成局部变量会 stale）。
  - **跨构建不得去重**：给 CE 构建加 `external: ['vue','pinia']` + import map 会让两侧共用同一份
    运行时（唯一能让"同一个实例"成立的路），但页面 bundle 不再自包含（失去独立验收/独立部署、
    版本与宿主强耦合、多宿主共存冲突）。
- 页面 `useRouter().push()` 与 agent `navigate()` 汇入同一真相源，靠 vue-router 桥的三个机制：
  路由表同步（哑组件 + addRoute）、guard 前移（core guard 挂 `beforeEach`）、
  防回环（`applying` **计数器**，因 vue-router 导航是异步的，布尔 flag 会被并发打穿）。

### 6.9 用法 B：宿主直连（host surface —— agent 直接操作你项目自己的 router）

除「容器 / WC 模式（**用法 A**）」外，runtime 还支持**宿主直连模式（用法 B）**：agent 的导航落到
宿主自己的 vue-router，页面在宿主自己的 `<router-view>` 渲染 —— 不编译 WC、不建容器、不做样式隔离。

- **内核 / 渲染面解耦（本次重构）**：`wc-runtime-core` 内部拆成
  **内核**（`kernel.ts`：导航真相源 + 服务/状态/事件/观测/留痕 + 页面目录 + 视图状态机）与
  **两个渲染面**（`surfaceContainer.ts` = WC 用法；`surfaceHost.ts` + `wc-runtime-vue/hostSurface.ts` = 宿主直连用法）。
  扩展点只有两个：`PageSurface` 与 `RuntimeHistory`；对外 `createRuntime({ surface })` 与既有 API 不变
  （缺省 `container`，行为与解耦前等价 —— 既有单测断言零改动）。
- **一套代码两条用法**：容器与宿主共用同一份内核；vue-router 桥的三机制（guard 前移 / `applying` 防回环 /
  回流 commit）抽在 `wc-runtime-vue/routerSync.ts` **一份**里，宿主版只是 `registerRoutes: false`（**绝不 addRoute**）。
- **真相源语义（重要，见 6.3 的修订）**：宿主模式下真实 URL 是最终裁决 → 双向镜像：
  内核导航 → `surface.render` → 桥 `apply` → `router.replace/push`；宿主 router 的 `afterEach` →
  `commit({ source:'host' })` 回流内核；`canGoBack/canGoForward` 与 `back/forward/go` 直接委托宿主 history
  （内核自身 entries 在宿主模式下只保留「当前页」一个槽位，不与真实 URL 发散）。
- **首屏**：`adopt`（缺省开）把宿主**当前路由**纳入内核，agent 首轮决策就知道用户在哪个页面；
  当前路由不在页面目录内（如登录页）则从空态开始；宿主模式不自动打开 manifest 第一个页面。

| 面 | 用法 A（容器 / WC） | 用法 B（宿主直连） |
|---|---|---|
| 页面渲染位置 | 面板内渲染区（容器 shadow root） | 宿主自己的 `<router-view>` |
| 需要的构建 | `wc.pages.json` + `vite.ce.config.ts` + `dist-ce/` | **无**（页面就是宿主组件） |
| 路由参数 | 归一成 props + 内存 router | 真实 `useRoute().params` |
| agent 直传 props | element property | 旁路 `useRuntimeServices().pageProps` |
| `defineExpose` → agent | 容器读 CE 实例 | 读 `currentRoute.matched[].instances.default` 的 `$.exposed` |
| `defineEmits` → agent | 容器自动捕获 CE 事件 | ⚠️ **不自动捕获**，页面需 `ctx.emit()` |
| 接口数据 → agent | `apiBus`（改 http 封装）或 observer | `observeNetwork: true` 零侵入（同副本，最准） |
| 样式 / UI 库 | 容器内打包 + shadow 隔离（有泄漏点要补） | 宿主自己的（无隔离问题） |
| 登录 / 路由守卫 | 容器内 memory router，不受宿主守卫约束 | 走宿主真实守卫（⚠️ 被拒时 URL 挡住，但 agent 仍拿 `ok:true` —— 已知缺口） |
| URL / 刷新 / 分享 | 宿主 URL 不变（页面在面板内） | URL 就是当前页 |
| 面板渲染区 | 有（欢迎页空态） | **无**（只显示状态；页面在宿主界面） |

- **硬约束**：① 面板必须挂在 `<router-view>` **之外**（挂路由组件里会被 agent 导航卸载）；
  ② manifest 的 `name` 必须等于宿主 route 的 `name`（init 一次性告警但**不中断**；缺失时导航返回
  `{ ok:false, reason:'not-found' }`，内核状态与宿主 URL 都不动）；
  ③ 单实例（`apiBus` / 网络观测是全局副作用）；④ agent 导航缺省 `replace`（不污染用户历史）。
- **接入**：`createVueHostRuntime({ router, app, manifestUrl })` + `<WebAssistant surface="host" :create-runtime>`；
  `wc.pages.json` **不声明 `container`**（analyzer 不写 `containers` / `pages[].bundle`）。
  完整清单、部署物对照与验收步骤见 [docs/INTEGRATION_GUIDE.md §9](./docs/INTEGRATION_GUIDE.md)。
- **验收台**：`pnpm dev:host`（demo-app 的 `host.html`）—— 与既有 SPA / WC 两条链路互不影响。
- 设计文档：[openspec/changes/add-host-router-surface](./openspec/changes/add-host-router-surface/)（proposal / design / specs / tasks）。

## 七、关键踩坑与解法
| 坑 | 现象 | 解法 |
|---|---|---|
| pnpm 11 忽略构建脚本 | esbuild/protobufjs build 被忽略 | `pnpm-workspace.yaml` 配 `onlyBuiltDependencies` |
| CSS 未进 shadow DOM | 页面依赖的共享组件 `<style>` 被抽出 `shared.css` 且无人加载 → 样式丢失 | 所有 `.vue` 按 custom-element 内联，`wcBuildPlugin` 把共享组件样式聚合进页面 `styles` |
| `process is not defined` | vue 产物 `process.env.NODE_ENV` 未替换 | 插件 `define` 显式替换 |
| vue-router Symbol 冲突 | `useRouter()` 返回 undefined | 手动 `app.provide(routerKey…)`（见 6.4） |
| 两个 vue 副本响应式不互通 | runtime-wc 用 `useRoute()` 不随路由更新 | PageHost 在 `afterEach` 手动更新 `tag` |
| element-plus 样式穿透不了 shadow DOM | 业务 WC 各自 shadow DOM 时 el-button 样式失效 | runtime-wc 统一隔离 + 业务 WC `shadowRoot:false` |
| element-plus `:root` 变量在 shadow DOM 失效 | `var(--el-*)` 不生效 | `:root`→`:host` 重写 + 光 DOM 注入 |
| element-plus 浮层 teleport 到 body | select 下拉/tooltip 样式丢失 | 光 DOM 注入一份原始 CSS |
| Vite library 模式不支持虚拟模块/包名作 entry | `Could not resolve entry module` | 生成真实入口文件 + `runtime` 用薄封装 |
| easyAutoI18nPlugin cleanup 污染词条 | CE 构建删掉主应用其它页面的 key | `localesDir` 指向临时目录 + `targetLangs: []` |
| `customElements.define` 不可注销 | 元素定义全局唯一，闭包捕获的 router 被「焊死」，第二个 runtime 实例失效 | 容器 provide + 页面 CE 继承（每实例一份）；`dispose()` 语义定为「解绑 + 卸载 DOM」而非回收定义 |
| CE 的对象 props 传不进去 | 用 attribute 传对象变成 `[object Object]` | 一律走 DOM property（容器渲染时给 props 加 `.` 前缀）；未升级元素上的赋值由 Vue `_resolveProps` 在 connect 时回收 |
| 宿主响应式实例跨副本失效 | 传入宿主 pinia/i18n 实例后页面「首次能读、之后不更新」 | 外层依赖只传纯函数/纯数据；业务状态走 `setState` 快照 + 容器侧 `shallowReactive` 副本；宿主 store 数据走 store 快照桥（宿主 `createHostStorePusher` + 容器 `createStoreMirror`，自动覆盖所有 store 且页面零改动） |
| vue-router 误判 isBrowser | Node 里给了 `document` 桩后 memory history 报 `history is not defined` | 单测里先 import 依赖 vue-router 的模块，之后再装 DOM 桩 |
| analyzer 解析不了 TS 页面 | 页面改 `<script setup lang="ts">` 后 babel 直接抛错 | `@vue/compiler-sfc` 切块拿 `block.lang`，babel 按需开 `plugins: ['typescript']` |
| TS 化后 manifest 丢 prop 类型 | `Array as PropType<User[]>` 让 `type` 解析成 `Any` | 解析时剥掉 `TSAsExpression` 再取构造器名；且**页面保留运行时 `defineProps({})` 写法**（类型写法拿不到注释里的 description） |
| vite 被解析成多个实例 | 插件返回的 `Plugin` 在 demo 侧报「两个同名但无关的类型」 | vite 的 `@types/node` 是可选 peer，版本不同就会分裂实例 → 消费方显式声明同版本 `@types/node`（根 `pnpm-workspace.yaml` 有 overrides 注释） |
| 改了 analyzer 源码但产物没变 | `wc-analyze` bin 指向 `dist/`，不会自动重建 | 用根脚本 `pnpm analyze`（先 build 再跑），别直接调 bin |
| 依赖往 `document.head` 注入样式，WC 里看不到 | CSS-in-JS 的 `<style>` 落在光 DOM，shadow DOM 匹配不到 | `styleShim`：指定包模块前置 `var document = shadowDocument(...)`（Rollup 改名收敛在包内）+ 容器登记 shadow root 为收件人 |
| 克隆体与源不同步（空 `<style>` + `insertRule`、先挂空后填） | clone 方案下镜像可能滞后成空壳，还要按内容去重（多个包同时空插入会撞车） | 改 clone 为**改道**：库自己的**真节点**直接移进容器 shadow root，`sheet` 天然生效，无需挂钩 / 去重 |
| 切页后样式没法销毁（ESM 只求值一次） | 直接删了、再进该页不会重新注入 → 掉样式 | **页级 scope**：`activateStyleScope(tag)` 把非当前页节点摘下缓存、切回再挂回 |
| 给 `document` 套裸 Proxy 就崩 | `document.createElement` 抛 `Illegal invocation`（品牌校验） | `bindProxy`：取属性 `Reflect.get(t,k,t)`、函数 `bind` 到真对象并缓存 |
| 用 `{...window}` 遮蔽 window 直接崩 | 变成普通对象、`addEventListener` 不是函数、`localStorage` 抛 SecurityError | 不遮蔽 `window`；`var document` 只覆盖裸标识符，`window.document` 记为已知缺口 |
| CSS-in-JS 注入代码散在子依赖里 | 只填主包名会漏（`3d-force-graph` 的样式其实由 3 个包各自注入） | 对目标子树逐包 `grep -c 'styleInject('`；构建后核对产物里未改写的 `document.head \|\| …getElementsByTagName("head")` 残留数为 0 |

## 八、运行方式

### 8.1 demo（webassistant 自带示例）

```bash
pnpm install
pnpm build:libs      # 构建 protocol / core / vue / plugin / analyzer（拓扑序）
pnpm build:ce        # 编译容器 + 页面为 WC（产物 demo-app/dist-ce/）
pnpm analyze         # 静态 + AI 生成 manifest v2
pnpm typecheck       # 全仓类型检查（tsc + vue-tsc）
pnpm test            # core 67 + vue 12 单测

# 方式 A：runtime 验收台（不依赖 chat-client，推荐先跑这个）
pnpm preview:ce      # 静态服务器 8080 → 打开 http://localhost:8080/
                     # 页面里直接 import core 的 dist（import map），按钮驱动 agent 导航 / 返回 /
                     # setState / 错误路由，右侧日志实时打印 navigate / status / page-event / error

# 方式 C：用法 B 验收台（宿主直连 —— agent 直接操作 demo-app 自己的 router）★ 新增
pnpm analyze:host    # 生成 demo-app/public/wc/manifest.json（host 批次：无 containers / 无 bundle）
pnpm dev:host        # 宿主 dev server → 打开 http://localhost:5173/host.html
                     # 页面在 demo-app 自己的 <router-view> 渲染，右下角是悬浮对话面板
                     # （面板挂在 router-view 之外，agent 导航不会把它卸载）
pnpm dev:agent -- --manifest-url http://localhost:5173/wc/manifest.json
                     # 或本地文件模式：pnpm dev:agent -- --manifest packages/demo-app/public/wc/manifest.json

# 方式 B：完整对话链路
pnpm preview:ce      # 终端1：静态服务器 8080
pnpm dev:agent       # 终端2：agent-server 3000（默认读 demo-app/manifest.json）
pnpm dev:client      # 终端3：chat-client 5173（proxy /wc→8080、/api→3000）
```

> 方式 A 不依赖 chat-client，适合先验收构建产物；方式 B 是完整对话链路。

### 8.2 接入另一个项目（如 ontology）

```bash
# 1. 发布/链接四个包（private 包需 --private）
cd packages/protocol         && yalc publish --private
cd packages/vite-plugin-wc   && pnpm build && yalc publish --private
cd packages/wc-runtime-vue   && pnpm build && yalc publish --private   # 会带上 core
cd packages/chat-client      && pnpm build:lib && yalc publish --private
# 目标项目：yalc add 这四个包 + pnpm install

# 2. 目标项目写 wc.pages.json（v2）+ vite.ce.config（复用宿主插件 + wc 插件）+ 容器入口 container.ts
# 3. 构建 WC：vite build --config vite.ce.config（产出 dist-ce + manifest）
# 4. 目标项目内嵌 client：<WebAssistant :services="{ request, t: $t, getToken, state }" />
#    （services 必须是框架无关的纯函数/纯数据，不要传 pinia / i18n 实例）
# 5. 启动 agent（指向目标项目的 manifest）
pnpm dev:agent:ontology   # 或 pnpm --filter agent-server dev -- --manifest <path>
```

## 九、进行中的设计：Agent Session 与页面数据回传

目标：让 agent 能「看到页面数据」并做多步操作。典型用例：「看名字为张三的用户详情」
—— user-detail 需 id，但用户只给了姓名，agent 需要先进列表页（用 keyword prop 过滤）、
等接口数据回传拿到 id，再跳详情。

已定的四条前提：**session** · **WebSocket 双向** · **侵入式改老项目（apiBus）** · **不做静默页面（可见执行）**。

三个面的映射（本轮的核心概念）：

| 面 | Vue 机制 | manifest 字段 | 方向 |
|---|---|---|---|
| 控制面 | `props` | `props[]` | agent → 页面（页面必须把可控入参声明成 props） |
| 观测面 | 接口响应（axios 拦截器 → apiBus） | **`dataSources[]`（新增）** | 页面 → agent |
| 通知面 | `emit` | `events[]` | 页面 → agent |

详细设计（ws 消息表、session 模型、侵入点、风险、待拍板清单）见
**[docs/agent-session.md](./docs/agent-session.md)**（状态：待 review，其中 D1 有三种方案并列）。

## 十、后续方向

1. **session 上下文**：让 agent 记住对话与页面事件（通道已就绪：runtime 的 `page-event` + `forwardPageEvents`）。
2. **react 批次**：新增 `wc-runtime-react`（实现 core 的 6 个 adapter 方法），同一个 manifest 里多一个
   `containers.react`，core 按 `route.framework` 懒建 —— core 的 containers 单测已用假 adapter 证明可插拔。
3. **agent-server 转 TS**（批 4）：复用 `@webassistant/protocol` 的 manifest / SSE 类型。
4. **页面内嵌套子路由**：目前 core 路由表是平的，页面自己的 `<router-view>` + children 尚不支持。
5. **页面内 `router.back()`**：会被 core 视为一次新导航（history 增长），建议用 `ctx.nav.back()`。
6. **iframe adapter**（已评估）：可消灭 `:root`→`:host` 重写、光 DOM 注入、CE 不可注销等一批 hack，
   代价是弹窗出不了 iframe 边界 + 高度自适应；core 不需改，只需新增一个 adapter（需给 core 加
   `adapter.loadPage?()` 扩展点，因为页面得在 iframe 内部 import）。
