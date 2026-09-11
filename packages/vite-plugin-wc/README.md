# @webassistant/vite-plugin-wc

由 `wc.pages.json` 驱动：把**一个 framework 批次**的「容器 + 页面」编译成一组可被 runtime 动态加载的 bundle。

- 插件读它 → 产出 `dist-ce/containers/<framework>.js` + `dist-ce/pages/*.js`
- [`@webassistant/analyzer`](../analyzer) 读同一份 → 产出 `manifest.json`（v2）
- 命名规则（tag / 入口名 / 产物路径）由 [`@webassistant/protocol`](../protocol) 统一定义，两边共用，不会漂移

---

## 1. wc.pages.json（v2）

```json
{
  "framework": "vue",
  "container": "src/ce/container.ts",
  "pages": [
    {
      "name": "UserList",
      "tag": "user-list",
      "path": "/users",
      "title": "用户列表",
      "component": "src/pages/UserList.vue"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `framework` | ❌ | 批次框架，缺省 `vue`；决定容器产物名与 manifest 的 `containers` 键 |
| `container` | ✅ | 容器入口**文件路径**（默认导出 adapter，见下） |
| `pageHelper` | ❌ | `definePage` 的来源，缺省 `@webassistant/wc-runtime-vue` |
| `sharedStyles` | ❌ | 跨容器共享样式（产物内相对路径），写进 `manifest.styles.shared` |
| `pages[].name` | ✅ | 路由名（PascalCase），供 `router.push({ name })` |
| `pages[].tag` | ❌ | 自定义元素标签，缺省由 name 推导 kebab-case；**必须含 `-`** |
| `pages[].path` | ❌ | 路由路径，支持 `:param`，缺省 `/<tag>` |
| `pages[].title` | ❌ | 页面标题 |
| `pages[].component` | ✅ | 组件路径：相对项目根 / 别名（`#/`、`@/`）/ 裸包名 |

启动即校验：缺 `container`、空 `pages`、缺 `name`/`component`、非法 tag、重复 tag 一律直接报错。

## 2. 容器入口（`container`）

```ts
// src/ce/container.ts
import { defineVueContainer } from '@webassistant/wc-runtime-vue'
import ElementPlus from 'element-plus'
import elementPlusCss from 'element-plus/dist/index.css?inline'

export default defineVueContainer({
  plugins: [ElementPlus],          // 每个页面 app 都会 app.use
  shadowStyles: [elementPlusCss],  // 注入容器 shadow root（:root → :host 自动重写）
  lightDomStyles: [elementPlusCss],// teleport 浮层用（隔离的已知泄漏点）
  setup(context) {                 // 只调一次：配置批次内共享单例（axios 拦截器等）
    setHttp(context.services.request)
  },
})
```

## 3. 三个插件

```ts
// vite.ce.config.ts
import { defineConfig } from 'vite'
import { wcVuePlugin, wcBuildPlugin, wcManifestPlugin } from '@webassistant/vite-plugin-wc'

export default defineConfig({ plugins: [wcVuePlugin(), wcBuildPlugin(), wcManifestPlugin()] })
```

| 插件 | 作用 |
|---|---|
| `wcVuePlugin()` | 返回 `[忽略 <style module> 的 pre 插件, @vitejs/plugin-vue]`，其 `customElement` 过滤 = 项目内所有 `.vue`（排除 node_modules）→ 页面与共享组件的 `<style>` 一律内联成 `.styles`（不再抽出 `shared.css`）；`<style module>`（CSS Module）在 custom-element 模式下不被 plugin-vue 支持，会被 pre 插件提前剥掉跳过 |
| `wcBuildPlugin()` | 生成页面入口文件（缓存到 `node_modules/.wc-entry/`）+ 配置 library 多入口、`external: []`、`define NODE_ENV`，并把「页面依赖树里共享组件的样式」聚合进各页面的 `styles` 导出 |
| `wcManifestPlugin()` | **可选的 manifest 分析集成**（仅显式启用时在 build 结束 / dev 监听变更时增量更新），默认构建插件不会自动分析；通常也可以单独执行 `wc-analyze` |

> `wcVuePlugin` 只用于 WC 构建；SPA 验证模式用普通 `vue()`。

## 4. 产物结构与入口契约

```
dist-ce/
├── containers/vue.js      # 容器（默认导出 adapter，自带框架与 UI 库）
├── pages/userList.js      # 每页一个，几 KB
├── context-*.js           # ★ 容器与页面共享的 vue
├── vue-router-*.js        # ★ 共享的 vue-router
└── definePage-*.js        # ★ 共享的注册助手
```

生成的页面入口（与 `wc-runtime-core` 的 `PageModule` 对齐）：

```js
import Page from '<component>'
import { definePage } from '@webassistant/wc-runtime-vue'
// styles = 页面自身样式 + 依赖树里共享组件的样式（wcBuildPlugin 构建期聚合）
export const styles = [...(Page.styles || []), .../* 共享组件样式 */]
export default (api) => definePage(Page, api)
```

**硬约束：容器与页面必须同一次构建**（★ 那几个共享 chunk 就是原因）。只有共享同一份框架实例，
页面 WC 才能继承容器 provide 的 services（Vue 3.5 `_inheritParentContext` 依赖 `instanceof VueElement`）。
因此不需要 import map，也不需要把依赖 external 出去。

## 5. 路径解析

- **别名**：优先 `options.aliases`，否则读项目 `package.json` 的 `imports`（如 `"#/*": "./src/*"`），支持 `*` 通配与精确匹配
- **裸包名**（`@scope/pkg`、`vue`）：原样返回交给 Vite
- **其它**：按相对项目根解析成绝对路径

## 6. 插件 options

```ts
wcBuildPlugin({
  configPath: 'wc.pages.json',
  entryDir: 'node_modules/.wc-entry',
  outDir: 'dist-ce',
  aliases: { '#/*': './src/*' },
})
wcVuePlugin() // 固定编译项目内所有 .vue，无需 options

// wcManifestPlugin：增量生成 manifest.json
wcManifestPlugin({
  configPath: 'wc.pages.json',       // wc.pages.json 路径（相对 root）
  outPath: '',                       // manifest 输出路径，缺省 wc.pages.json 同目录 manifest.json
  noAi: false,                       // true = 只做静态解析，跳过 DeepSeek AI 分析
  cacheFile: '.wc-manifest-cache.json', // 指纹缓存（增量复用依据）
  aiCacheFile: '.analyze-cache.json',   // AI 结果缓存
  ai: {                              // 默认由 Vite 宿主 .env/.env.local 的 DEEPSEEK_* 提供
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL,
  },
  watch: true,                       // dev 模式是否监听变更增量更新
})
```

## 6.1 wcManifestPlugin 增量策略

- **指纹**：`sha256(sourceCode + routePath + title + componentPath + framework)`。
- **未变化**（指纹命中缓存且旧 manifest 有条目）→ 直接复用旧条目，**保留手工维护字段**（`dataSources` / `meta`）。
- **变化 / 新增** → 重新静态解析（`@vue/compiler-sfc` + babel）+ AI 语义分析（DeepSeek，带缓存）。
- **删除**（wc.pages.json 移除某页）→ manifest 同步移除该页。
- dev 模式下监听 `wc.pages.json` 与页面组件源码变化，热更新 manifest（agent-server 会按 mtime 热重载）。

## 7. 已知限制

- 公共依赖全量打进本批次（`external: []`），容器 bundle 较大（demo 约 1.8MB，含 element-plus JS+CSS）；
  好处是零宿主协作、零 import map，且批次内单实例
- `container` 必须是文件路径（Vite library 模式不支持包名作 entry）
- `<style module>`（CSS Module）暂不支持：`@vitejs/plugin-vue` 在 custom-element 模式下会抛
  `<style module> is not supported in custom elements mode.`，因此 `wcVuePlugin` 会在构建期把这些块静默剥掉跳过（构建日志会有一条 warning）
- 新增页面：写 `.vue` → `wc.pages.json` 加一条 → `vite build --config vite.ce.config.ts` 构建 bundle；再执行 `pnpm analyze` 生成/更新 manifest
- 若消费方与本插件解析到不同的 `vite` 实例（`@types/node` 版本不同会导致），`Plugin` 类型会互不兼容；
  在消费项目里显式声明 `@types/node` 与本包一致即可（见根 `pnpm-workspace.yaml` 的 overrides 注释）
