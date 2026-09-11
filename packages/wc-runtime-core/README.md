# @webassistant/wc-runtime-core

**定义层**：框架无关的 WC runtime 契约 + 编排实现。

> 本包不对外。宿主与批次入口请使用 **[@webassistant/wc-runtime-vue](../wc-runtime-vue)**（唯一门面），
> core 只被各框架实现（vue / 未来的 react）衍生使用。

---

## 1. 分层与依赖二分模型

```
宿主（chat-client / ontology）
   │ services（外层传入：request / t / getToken / theme / state / emit）
   │ navigate({ tag, params, source:'agent' })
   ▼
wc-runtime-core（本包，零框架依赖）
   manifest · navigation(真相源) · loader · containers · services/state · styles · props · events · view
   │ 按 route.framework 懒加载对应容器 → adapter
   ▼
<runtime-vue> / <runtime-react>（容器 WC = 唯一样式隔离边界，各自批次的 bundle）
   持有 runtime 自有依赖：vue / vue-router / element-plus（+CSS）
   把 services provide 给页面
   ▼
<user-list> <user-detail> …（页面 WC，shadowRoot:false，渲染在容器 shadow root 内）
```

| 依赖类型 | 例子 | 何时确定 | 传递机制 | 约束 |
|---|---|---|---|---|
| **runtime 自有** | vue、vue-router、element-plus | 构建期 | 与页面**同批构建** → Vite 共享 chunk → 页面用相对 URL import → 浏览器按 URL 去重 → 同一模块实例 | 无 |
| **外层传入** | request、t、token、theme、state | 运行时 | 宿主 → `servicesRef` → 容器 `app.provide` → 页面 CE 继承 | **必须框架无关**：纯函数 / 纯数据 / 订阅回调 |

### 硬约束：一个 framework 批次 = 一次构建 = 一个产物目录

```
dist-ce-vue/                          dist-ce-react/
├── containers/vue.js  → <runtime-vue>   ├── containers/react.js → <runtime-react>
├── pages/*.js         （几 KB/页）       ├── pages/*.js
└── chunk-vue-*.js  ← 容器与页面共享     └── chunk-react-*.js
    chunk-element-plus-*.js                  chunk-antd-*.js
```

容器**必须**与它的页面同批构建，否则不共享框架实例：Vue 的 `VueElement` 类不同 → 子 CE 无法继承父容器的 provide
（Vue 3.5 `_inheritParentContext` 依赖 `instanceof VueElement`）→ 又要退回手动 symbol 桥接。
跨批次不共享（不同框架本来无从共享），因此不需要 import map，也不需要构建期 external 重写。

> 实证：现有 `dist-ce/pages/userList.js` 与 `pages/runtimeHost.js` 都 `import "../runtime-dom.esm-bundler-*.js"`，
> 即容器与页面早已共用同一份 vue 副本；1.9MB 产物里业务代码只占 0.9%，其余是共享的公共依赖。

### 为什么外层依赖必须框架无关

宿主与 runtime 是两份框架副本。宿主 `pinia store` / `vue-i18n` 实例 / `ref` 的响应式依赖收集发生在**宿主副本**，
runtime 侧的渲染 effect 不会被登记 → 页面「首次能读到、之后不更新」。所以业务状态统一走**快照单向同步**：

```
宿主 watch(自己的 store) → runtime.setState(纯数据) → StateBridge → 容器的 shallowReactive 副本 → 页面正常响应
页面变更 → services.emit(event, payload) → runtime 'page-event' → 宿主写回自己的 store / 转发 agent
```

`createServicesRef` 会在检测到 `__v_isRef` / `__v_isReactive` / pinia / vue-i18n 实例时 `console.warn`。

---

## 2. manifest v2（唯一支持的 schema）

```json
{
  "version": 2,
  "containers": {
    "vue":   { "bundle": "containers/vue.js",   "tagName": "runtime-vue" },
    "react": { "bundle": "containers/react.js", "tagName": "runtime-react" }
  },
  "styles": { "shared": ["shared/tokens.css"] },
  "pages": [
    {
      "name": "UserDetail", "tag": "user-detail", "path": "/users/:id",
      "title": "用户详情", "framework": "vue", "bundle": "pages/userDetail.js",
      "params": [{ "name": "id", "type": "string" }],
      "props":  [{ "name": "user", "type": "Object", "description": "…" }],
      "events": ["save"]
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | ✅ | 必须为 `2` |
| `containers[framework].bundle` | 条件 | 容器 bundle；若该 framework 的 adapter 已预注册可省略 |
| `containers[framework].tagName` | ❌ | 缺省 `runtime-<framework>` |
| `styles.shared` | ❌ | 跨容器共享的样式 URL（框架无关 tokens），init 时 fetch 进 `shared` 层 |
| `pages[].name` | ✅ | 路由名，供 `router.push({ name })` |
| `pages[].tag` | ❌ | 缺省由 name 推导 kebab-case；**必须含 `-`** |
| `pages[].path` | ❌ | 缺省 `/<tag>`；支持 `:param` |
| `pages[].framework` | 条件 | 只有一个容器时可省略；多容器必填 |
| `pages[].bundle` | ✅ | 页面 bundle 路径（相对 `assetBase`） |
| `pages[].params/props` | ❌ | `params` 缺省从 path 提取；两者的 `type` 用于 agent 传值的归一 |
| `pages[].events` | ❌ | 页面 emit 的事件名，容器据此挂监听 → `page-event` |

校验（`normalizeManifest`）：版本、空 pages、重复 tag/name、非法 tag、未知 framework 一律抛错。

---

## 3. bundle 契约

```js
// 容器 bundle（containers/vue.js）：默认导出一个 adapter
import { defineVueContainer } from '@webassistant/wc-runtime-vue'
export default defineVueContainer({ plugins: [ElementPlus, pinia], shadowStyles: [epCss] })

// 页面 bundle（pages/userDetail.js）
import Page from '<component>'
import { definePage } from '@webassistant/wc-runtime-vue'
export const styles = Page.styles || []          // custom-element 编译产出的 <style>
export default (api) => definePage(Page, api)    // 也可命名导出 definePage
```

---

## 4. adapter 契约（框架实现只需这 6+2 个方法）

```ts
interface RuntimeAdapter<H> {
  readonly framework: string
  readonly defaultTagName?: string
  defineContainer(options: { tagName, servicesRef, navigation, onPageEvent }): H
  mountContainer(handle: H, root: Element): void
  patchContainer(handle: H, view: RuntimeView): void
  unmountContainer(handle: H): void
  definePage(module: PageModule, api: PageApi): void
  createRouterBridge?(api: RouterBridgeApi): RouterBridge   // 可选：桥接框架 router
  dispose?(): void
}
```

`RuntimeView` 是**下发给容器的唯一数据结构**：

```ts
interface RuntimeView {
  framework: string | null
  tag: string | null                    // 当前要渲染的业务 WC
  props: Record<string, unknown>        // params + 声明 props + 直传 props（已按 type 归一）
  styles: readonly string[]             // base → shared → page，已去重排序
  stylesVersion: number                 // append-only 单调递增
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: { message, tag?, framework?, cause? }
  title?: string
  events: readonly string[]             // 当前页面声明的事件名
}
```

**props 必须写成 element property**（对象无法经 attribute 传递）。Vue CE 支持 pre-upgrade property：
未升级时赋值成为 own property，`_resolveProps` 在 connect 时会回收，因此渲染顺序安全。

---

## 5. 导航：单一真相源 + 两条入口

`NavigationController` 是「当前页面」的唯一真相源。agent 与页面内的 `router.push` 汇入同一条路：

```
① agent / 宿主：runtime.navigate({ tag, params, source:'agent', replace:true })
② 页面内老代码：useRouter().push({ name, params })
        │ vue-router.beforeEach → api.canNavigate(target)   ← core 的 guard 前移，页面能拿到 NavigationFailure
        │ vue-router.afterEach  → api.commit(target)        ← 落地到 core（不会再回推，避免回环）
        ▼
core：resolve → 确保容器就绪 → nav.commit → 计算 view（tag/props/styles/status/title/events）
        → adapter.patchContainer → 其余容器清空/卸载 → emit navigate|view|status
        → 若不是来自 bridge：bridge.apply(location, replace) 让框架 router 与 core 对齐
```

寻址支持 `tag`（agent 用）/ `name`（老代码用）/ `path`（含 `:param` 反解 + query 解析）。
history 维护 entries+index，支持 `back / forward / go(n)` 与 `canGoBack / canGoForward`（上限 50 条）；
`replace` 与「同页同参」不新增历史条目。`source` 取值 `initial | agent | page | host`。

`NavigationResult` 失败原因：`not-found | aborted | empty | out-of-range | load-failed`。

### 状态机

```
idle ──navigate──▶ loading（页面 bundle 未加载时的中间帧）──▶ ready
                          └────────── 加载失败 ─────────────▶ error（路由已落地，可继续导航离开）
```
容器已加载过的页面只出 `ready` 一帧（无多余 loading 抖动）。容器加载失败则**不落地**导航。

## 6. 事件表（`runtime.on`）

| 事件 | payload | 用途 |
|---|---|---|
| `view` | `RuntimeView` | 每次渲染帧（调试 / 自定义宿主） |
| `navigate` | `{ location, route, source, canGoBack, canGoForward }` | 更新标题、返回按钮；可回传 agent |
| `status` | `{ status, tag }` | loading / error 指示 |
| `page-event` | `{ tag, event, payload }` | 页面 emit → 宿主 → agent（session 上下文的前置） |
| `state` | `{ patch, keys }` | 宿主状态快照已同步 |
| `services` | `{ keys }` | services 被替换 |
| `error` | `RuntimeErrorInfo` | 导航 / 加载失败 |

## 7. 样式分层

`base`（UI 库，容器自带）→ `shared`（manifest.styles.shared，跨容器 tokens）→ `page`（页面 `styles`）。
按 `${layer}::${id}` 去重、**append-only**（只追加不重排，避免切页闪烁）、`stylesVersion` 单调递增。
`dom.ts` 另提供 `rewriteRootToHost`（`:root`→`:host`，UI 库变量在 shadow DOM 内生效）、
`createSharedSheet` / `adoptSheets`（同一 `CSSStyleSheet` 跨多个容器 shadow root 共享）、
`injectLightDomStyles` / `injectLightDomStylesBulk`（UI 库浮层 teleport 到 body 的**已知隔离泄漏点**补丁，
前者注入单段、后者按内容哈希去重批量注入页面样式）、`applyThemeVars`。

### 7.1 反向：document → shadow root（`styleSink.ts`）

上面那几个函数解决的是 **shadow → 光 DOM**（浮层用）。反方向（依赖往 `document.head` 注入样式、
但 WC 在 shadow DOM 里看不到）由 `styleSink.ts` 兜：

- **目标注册表**：`addStyleTarget(shadowRoot)` / `removeStyleTarget` / `currentStyleTargets`。
  状态挂在 `globalThis` + `Symbol.for('webassistant.styleSink')` 上 —— 容器 bundle / 共享 chunk /
  页面 bundle 是多份模块副本，模块级变量会各持一份（同 `activity.ts`），挂全局才是唯一真相源。
  容器在 `mountContainer` 登记自己的 shadow root、`unmountContainer` / `dispose` 注销。
- **`shadowDocument(realDoc)`**：给「指定包」做词法遮蔽用的 document 代理 ——
  `vite-plugin-wc` 的 `styleShim` 会把指定包模块前置成
  `var document = …shadowDocument(globalThis.document)`，包内裸 `document` 的样式插入即被**改道**：
  命中的 `<style>` / `<link rel=stylesheet>` 由代理**直接把库自己的真节点移进**注册表里的 shadow root
  （不再往 head 放、也不再克隆）。样式因此归容器所有 —— 容器卸载即随元素销毁；
  库后续的 `sheet.insertRule/deleteRule`、`appendChild(textNode)`、`textContent = css`
  都**直接作用于该节点自身**（真节点进了已连接的 shadow root → `sheet` 存在），无需任何同步挂钩。
- **页级 scope（摘下 / 挂回）**：`beginStyleScope(tag)` 标记「页面加载窗口」，其内注入的样式归属该页；
  `activateStyleScope(tag)` 在 `render()` 时把**非当前页**的节点从容器摘下（保留在内存组里）、
  把当前页的挂回；`endStyleScope()` 收尾；`clearStyleScopes()` 在 `runtime.dispose` 时清空。
  原因：ESM 模块只求值一次，切页不能真销毁、只能摘挂。未 `beginStyleScope` 的注入（容器级）
  归兜底 scope `DEFAULT_STYLE_SCOPE`，恒定挂着、不参与摘挂。
- **`bindProxy`**：忠实透传的代理工厂。原生 DOM 方法有品牌校验，直接 `new Proxy(document, {})`
  会在 `document.createElement(...)` 抛 `Illegal invocation`，因此取属性必须
  `Reflect.get(target, key, target)`、函数必须 `bind` 到真对象并缓存。
- **`installStyleSink()`**：把 API 挂到 `globalThis[Symbol.for('webassistant.styleSink.api')]`，
  由构建期注入的 prelude 调用。

已知缺口：`window.document` / `globalThis.document` 等全局属性路径不覆盖（本方案不遮蔽 `window`）；
改道固定投到 `targets[0]`（单容器假设，多容器 / 多 runtime 后续用 iframe 或 target 作用域解决）。

## 8. 生命周期与已知限制

- **自定义元素不可撤销**：`customElements.define` 全局且不可注销。因此 `dispose()` 的语义是
  「解绑事件 + 卸载容器 DOM + 释放桥」，而不是回收元素定义；重复 `dispose()` 幂等。
- 每次 `createRuntime` 都应配一份独立 adapter（`createVueRuntime` 已如此）。若多个 runtime 共享同一个
  **容器 bundle 模块**，adapter 是模块单例，其内建 router 也会共享 —— 研究阶段的已知限制。
- **页面内嵌套子路由**（页面自己的 `<router-view>` + children）暂不支持。
- 页面内 `router.back()` 会被视为一次新导航（history 会增长）；建议用 `services.nav.back()` 或宿主返回按钮。
- core 只有 `dom.ts` 触碰 DOM 且全部做 `typeof` 守卫，其余模块可在 Node 里直接单测。

## 9. 开发

```bash
pnpm --filter @webassistant/wc-runtime-core build
pnpm --filter @webassistant/wc-runtime-core test    # node --test，66 例，零额外依赖
```

`test/helpers.js` 提供假 adapter（记录调用序列）+ 假 importer，可脱离 DOM 验证编排；
`test/multi-framework.test.js` 用 vue + react 两个假 adapter 证明多框架契约可插拔。


