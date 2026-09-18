# unify-page-manifest

## Why

两种用法（A：容器 / WC；B：宿主直连 / host）目前各有一份清单与一份 manifest：

| 产物 | 生成命令 | 形状 |
|---|---|---|
| `public/wc-ce/manifest.json` | `pnpm analyze`（`wc.pages.json`，含 `container`） | 有 `containers.vue` + `pages[].bundle` |
| `public/wc/manifest.json` | `pnpm analyze:host`（`wc.host.json`，无 `container`） | 无 `containers`、无 `pages[].bundle` |

两份清单除 `container` 字段与页面成员外**逐字段重复**（demo 实测：`Dashboard` / `OrderList` 仅 host，`Lab` 仅 wc，其余 4 页 `name` / `tag` / `path` / `title` / `component` / `dataSources` 逐字相同）。而两份 manifest 的差异**对 host 模式没有任何意义**：

| 检查 | 结论 | 证据 |
|---|---|---|
| `RuntimeRoute.bundle` 的消费点 | 全在容器侧 | `surfaceContainer.ts:43`、`containers.ts:66-78`、`container.ts:385` |
| `NormalizedManifest.containers` 的消费点 | 只有容器渲染面 | `surfaceContainer.ts:65` |
| 宿主渲染面（`surfaceHost.ts` 全文） | 只用 `framework` / `validateRoutes` / `apply` / `snapshot` / `history` / `getPageExposed` —— 无 bundle 概念 | `surfaceHost.ts` |
| `forHostSurface` 校验语义 | **放宽必填**，不拒绝多余字段 | `manifest.ts:76,81` |
| agent-server 校验 | 只校验「`bundle` 给了必须是字符串」 | `manifest.service.ts:343` |

也就是说：`pnpm analyze:host` 这条命令、`wc.host.json` 这份清单、`public/wc/**` 这份 manifest 都在为**一个不存在的差异**付出维护成本 —— 三份文档要反复解释「/wc 其实是 host 批次、/wc-ce 才是容器批次」，且两份清单会各自漂移（`rules/domain.md` 说 `/lab` 不可导航、`wc.pages.json` 又把 `Lab` 列成可导航页，就是已发生的漂移）。

命名上更该消失的是 `/wc-ce`：`/wc/manifest.json` 已被**生产部署**（`deploy.sh:34` `MANIFEST_URL=.../wc/manifest.json`）、**agent-server 本地模式提示**（`manifest.service.ts:298`）、**chat-client 的 `wcBase` 缺省值**（`useWebAssistant.ts:128`）三方锚定。

## What Changes

- **一份清单**：删除 `packages/demo-app/wc.host.json`；`wc.pages.json` 成为唯一清单，pages 取两批并集。
- **一次构建**：删除 `analyze:host`（包级与根级）；`pnpm analyze` 成为唯一 manifest 生成命令。
- **一份 manifest**：唯一 manifest 落在 `public/wc/manifest.json`（容器形状：带 `containers` + `pages[].bundle`），
  host 模式**直接消费同一份** —— 多出的 `containers` / `bundle` 被宿主渲染面忽略。
- **URL 收敛**：容器批次的产物 URL 前缀由 `/wc-ce/dist-ce/**` 改为 `/wc/dist-ce/**`，
  于是 `wcBase` 在两条链路都是 `/wc`（chat-client 的缺省值），容器模式连 `wc-base` 都不用传。
  涉及 `vite.config.ts` 的中间件前缀、`serve.mjs` 的静态映射、`wc-demo.html` 的 `manifestUrl` / `assetBase`。
- **不变量加固**（`wc-runtime-core/src/manifest.ts`）：`forHostSurface` 时显式把 `pages[].bundle` 置 `''`、
  `containers` 置空 —— 让 `types.ts:31` 的注释（「宿主渲染面模式下为空字符串」）从「注释说了、实现没做」
  变成真不变量；同时保留「bundle 可缺」的放宽语义。
- **模式差异归运行时**：`/lab`（能力验收室）在合并后进入 host 模式的页面目录 → 更新 `rules/domain.md`
  的对应用语。**不**引入「按 target 过滤清单」的机制：manifest 表达的是**页面能力目录**，
  某模式下少开放一页属于运行时策略，且 `runtime.beforeEach` 拦不住「只拦 agent 不拦用户」
  （`NavigationGuard` 拿不到 `source`，桥的守卫前移会把宿主点击一并送进 `canNavigate`）——
  因此「按模式拆清单」既贵又不准。

**明确不做**（留待后续）：页面级 `targets` + `--target` 双侧过滤 + 插件按 target 构建。
若将来真出现「两批页面集合必须不同」的诉求，那时再加（本变更的 `--out` 集中映射为它留了位置）。

## Capabilities

### New Capabilities

- `single-page-manifest`: 一份清单 → 一份 manifest，两条渲染面共用；manifest 的 WC 专属字段
  （`containers` / `pages[].bundle`）只对容器渲染面有意义，宿主渲染面 MUST 忽略它们且 MUST NOT 因此报错。

### Modified Capabilities

（无：`openspec/specs/` 尚无正式 spec，本变更只新增能力。）

## Impact

- `packages/demo-app`：删 `wc.host.json`；`wc.pages.json` pages 并集；`package.json`（删 `analyze:host`、
  `analyze` 改 `--out public/wc/manifest.json`）；`vite.config.ts`（`/wc/dist-ce` 前缀 + `closeBundle` 目标）；
  `serve.mjs`（静态映射）；`wc-demo.html`（`manifestUrl` / `assetBase`）；`src/pages/AssistantWc.vue`（去 `wc-base`）；
  `src/components/AssistantDock.vue`（`manifestUrl` 改由 `ctx.base` 推导）；`src/router/index.ts`、`src/api/users.ts`、
  `src/pages/UserList.vue` 的注释文案。
- 根 `package.json`：删 `analyze:host` 脚本。
- `packages/wc-runtime-core`：`src/manifest.ts`（host 分支清空 `bundle` / `containers`）。
- 文档：`README.md`、`PROJECT.md`、`docs/INTEGRATION_GUIDE.md`、`docs/agent-session.md`、
  `packages/demo-app/README.md`、`packages/wc-runtime-vue/README.md` 中 `/wc-ce` 与「host 批次」措辞。
- 测试：`packages/wc-runtime-core/test/manifest.host.test.js`（补「host 分支清空 bundle/containers」断言）。
- changeset：`wc-runtime-core`（patch）+ demo 说明。
- **不动**：`agent-server`、`vite-plugin-wc`、`protocol`、`deploy.sh`、`docker-compose.yml`、
  所有既有 `/wc/manifest.json` 引用。
