## Context

两条渲染面（`container` = 用法 A / WC；`host` = 用法 B / 宿主直连）自 `add-host-router-surface` 起共用同一个内核，
但**产物层**分叉成了两套：两份清单（`wc.pages.json` / `wc.host.json`）、两个分析命令（`analyze` / `analyze:host`）、
两份 manifest（`public/wc-ce/` / `public/wc/`）。本变更把产物层收回一份。

分叉的**全部**理由只有一条：`analyze` 的 `hostOnly` 判据是「清单有没有声明 `container`」（`analyze.ts:95`），
于是 host 批次需要一份不声明 `container` 的清单。而这条判据对**运行时**毫无必要 —— host 渲染面根本不读
`containers` / `pages[].bundle`（见 proposal 的证据表）。

## Goals / Non-Goals

**Goals**

- 一份清单、一条分析命令、一份 manifest；host 与容器两条链路消费同一份。
- 删除反直觉命名 `/wc-ce`（保留 `/wc`，它与生产 `MANIFEST_URL`、agent-server 提示路径、`wcBase` 缺省值一致）。
- `forHostSurface` 下的 `assets` 语义从「注释约定」升级为「归一化不变量」。

**Non-Goals**

- 不改 `protocol` 的 `WcPagesConfig` schema（不引入 `targets` / `--target`）。
- 不改 `agent-server` / `vite-plugin-wc` / `protocol`。
- 不改两条渲染面的内核语义（导航真相源、桥、store 快照桥、activity 总线等一律不动）。

## Decisions

### D1 唯一 manifest 落 `/wc/manifest.json`，容器产物落 `/wc/dist-ce/**`

被 `deploy.sh:34`（生产 `MANIFEST_URL=https://…/wc/manifest.json`）、`manifest.service.ts:298`
（本地文件模式提示 `../demo-app/public/wc/manifest.json`）、`useWebAssistant.ts:128`（`wcBase` 缺省 `/wc`）
三方锚定的是 **`/wc`**，不是 `/wc-ce`。选 `/wc` 后：生产配置、20+ 处文档引用、host 侧 `manifestUrl` 全部零改动；
需要改名的只有 12 处 `/wc-ce`。

**代价**：容器模式 `<WebAssistant>` 的 `wc-base` 可以省略（缺省即 `/wc`）。

### D2 host 渲染面直接消费容器形状的 manifest

安全性由三点保证：① `route.bundle` / `manifest.containers` 的消费点全在容器侧（grep 证据见 proposal）；
② `forHostSurface` 只放宽必填、不拒绝多余字段（`manifest.ts:76,81`）；③ agent-server 只校验
`bundle` 的类型（`manifest.service.ts:343`）。**风险点是「将来有人给 host 面加 bundle 相关逻辑」** →
由 D3 把「host 面的 bundle 恒为空」变成硬不变量来防住。

### D3 `forHostSurface` 时归一化显式清空 `bundle` / `containers`

```ts
bundle: options.forHostSurface ? '' : page.bundle ? joinUrl(assetBase, page.bundle) : ''
// containers: options.forHostSurface ? [] : <原逻辑>
```

理由：`types.ts:31` 已声明「宿主渲染面模式下 `bundle` 为空字符串」，但实现只在「manifest 没给 bundle」时
才成立 —— 给了就是 `joinUrl(undefined, 'pages/x.js') = 'pages/x.js'`（相对路径残留）。
清空之后：不变量成立、host 面拿到的 manifest 与「host 专属 manifest」**行为完全等价**，
这也正是 D2 可以放心复用同一份 manifest 的前提。

### D4 页面集合合一；模式差异归运行时，且 `/lab` 走「开放」

合并后页面集 = 两批并集（demo：7 页）。`/lab` 因此进入 host 模式的页面目录。

**为什么不用 `runtime.beforeEach` 拦**（推翻初版方案）：`NavigationGuard = (to: RuntimeLocation, from) => boolean | void`
（`types.ts:94`），`RuntimeLocation` 不含 `source`，而桥的守卫前移把**宿主自己的导航**也送进同一条
`canNavigate`（`navigation.ts:261-268`）→ 拦 `/lab` 会连宿主侧栏点击一起挡掉。
因此「按模式差异拦某一页」在现有 API 下无法表达；选项只剩「开放」或「从共用清单删除」。

**取「开放」**：`/lab` 是 runtime 能力验收室（浮层样式 / CSS-in-JS / 3D 图），agent 打开它本身无害且有演示价值；
同步更新 `rules/domain.md` 里「（/lab，agent 不可导航）」那半句。

### D5 不做 `pages[].targets` / `--target`（留位置）

一份清单在 `analyze` 里硬编码出一个输出路径即可满足当前两类项目（两批页面集合相同）。
若将来真出现「两批必须不同」的需求，加 `targets` 的落点是明确的：`analyze.ts` 的 `hostOnly` 判据旁
（`analyze.ts:95`）+ CLI `--target`（`analyzer/src/index.ts:18-30`）+ 插件过滤（`vite-plugin-wc/src/index.ts:295`）。
现在加它会让容器批次多编无用 bundle 且引入「manifest 与产物不一致」的新坑。

### D6 共用清单 ⇒ 所有 `tag` 必须满足自定义元素规范（实施中发现）

原方案未预见：`vite-plugin-wc` 的 `loadWcPages` 校验 `tag` 必须含 `-`（`config.ts:37-39`），
而 analyzer 不做该校验（`analyze.ts` 直接 `JSON.parse`）。于是 `Dashboard` 的 `tag: 'dashboard'`
（host 面一直合法 —— tag 在那里只是稳定 ID）在合并后让 `pnpm build:ce` **直接失败**，
且报错点在构建期、离清单很远。

处理（两条一起）：
1. `tag: 'dashboard'` → `app-dashboard`（与仓库既有命名示例 `AppDashboard → app-dashboard` 一致）；
2. analyzer 在清单声明了 `container` 时，对不含 `-` 的 `tag` **提前警告**（把问题暴露在清单期）。

含义写进文档：一份清单驱动两批 ⇒ 所有 `tag` 都要按自定义元素规范写。

## Risks / Trade-offs

| 风险 | 缓解 |
|---|---|
| host 面消费带 `bundle` 的 manifest 有未知副作用 | D3 清空后二者等价；实跑 §9.7 验收清单 |
| demo 容器批次多编 2 个页面（Dashboard / OrderList） | 有意为之（并集）；产物体积影响可忽略，且让两模式页面集一致 |
| `/wc-ce` → `/wc` 改名遗漏 | 以 `grep -rn '/wc-ce'` 清零为准（当前 12 处） |
| 两份清单删掉后 `dataSources` 声明被误删 | `wc.pages.json` 取并集时逐字段核对（`Dashboard` / `OrderList` 的 `dataSources` 从 `wc.host.json` 迁入） |

## Verification

1. `pnpm analyze` 产物结构与预期一致：`version 2` + `containers.vue` + 7 页全带 `bundle`，且与
   `dist-ce/pages/**` 逐条对得上（7/7）。
   > 说明：**逐字节 diff 与改动前不可得** —— `public/` 产物未入库（`.gitignore` 未含但从未提交），
   > 且工作区在本次改动前已有未提交修改（旧清单的「改动前」状态无法从 git 复原）。
   > 等价性改由单测锁定：「容器形状 manifest 走宿主归一化后，页面目录与容器模式逐字段相等」
   > （`wc-runtime-core/test/manifest.test.js`），以及「共用页面条目未被本次编辑触碰」。
2. `pnpm build:ce` 后 `dist-ce/pages/` 出现 `dashboard.js` / `orderList.js`（并集预期）。
3. host 模式实跑（核心风险）：`pnpm dev` + `pnpm dev:agent -- --manifest-url http://localhost:5173/wc/manifest.json`，
   对着 `docs/INTEGRATION_GUIDE.md` §9.7 清单逐条验收。
4. `pnpm typecheck`、`pnpm test`（`wc-runtime-core/test/manifest.host.test.js` 补 D3 断言）。
5. `pnpm preview:ce`（8080）+ `/assistant` 容器链路冒烟；`wc-demo.html` 直连 runrime 层冒烟。
