## 1. 清单合一（packages/demo-app）

- [x] 1.1 `wc.pages.json`：pages 取两批并集 —— 从 `wc.host.json` 迁入 `Dashboard`（含 `dataSources`）与
      `OrderList`（含 `dataSources`），保留既有 5 页；顺序 `Dashboard / UserList / UserDetail / OrderList /
      DatasourceAdmin / Settings / Lab`；顺带把 `UserList` / `UserDetail` 的 `dataSources.description`
      取两版中**信息更全**的那份（避免合并丢失「邮箱不出网」「保存后按同样字段回报」的约束）
- [x] 1.2 删除 `wc.host.json`
- [x] 1.3 `package.json`：删 `analyze:host`；`analyze` 改为
      `mkdir -p public/wc && wc-analyze --config wc.pages.json --out public/wc/manifest.json`
- [x] 1.4 根 `package.json`：删 `analyze:host` 脚本（`dev:host` 别名保留）

## 2. URL 收敛：`/wc-ce` → `/wc`

- [x] 2.1 `demo-app/vite.config.ts`：`WC_ASSET_URL = '/wc/dist-ce'`；`closeBundle` 拷贝目标改 `dist/wc/dist-ce`；
      插件名 `wa-wc-ce-assets` → `wa-wc-assets`
- [x] 2.2 `demo-app/serve.mjs`：静态映射 `/wc/dist-ce/` → `/dist-ce/`
- [x] 2.3 `demo-app/wc-demo.html`：`manifestUrl: '/wc/manifest.json'`、`assetBase: '/wc/dist-ce'`
- [x] 2.4 `demo-app/src/pages/AssistantWc.vue`：去掉 `wc-base="/wc-ce"`（用缺省 `/wc`）；更新页面清单文案
- [x] 2.5 删除 `packages/demo-app/public/wc-ce/`
- [x] 2.6 **（实施中新增）** agent-server 默认 manifest 路径与提示文案：`public/wc-ce/` → `public/wc/`
      （`manifest.service.ts:323`、`src/main.ts:37`）—— 不改会让 `pnpm dev:agent` 无参启动即崩

## 3. host 模式接线与注释

- [x] 3.1 `demo-app/src/components/AssistantDock.vue`：改用 `createVueHostRuntimeBinding({ router, app, services })`
      （manifestUrl 由 binding 按 `ctx.base` 推导，不再硬编码）
- [x] 3.2 `demo-app/src/router/index.ts` 注释：清单来源改为 `wc.pages.json → public/wc/manifest.json`；
      并注明 `/lab` 现在**在**目录内（不再是 passThrough）
- [x] 3.3 `demo-app/src/api/users.ts`、`src/pages/UserList.vue`：去掉 `wc.host.json` 字样

## 4. 内核不变量（packages/wc-runtime-core）

- [x] 4.1 `src/manifest.ts`：`forHostSurface` 时 `pages[].bundle` 恒为 `''`、`containers` / `sharedStyles` 恒为空
- [x] 4.2 `test/manifest.test.js`：两条新断言 —— ① 容器形状 manifest 走宿主归一化后 WC 资产全空、
      页面目录与容器模式**逐字段相等**；② 宿主面不靠 `containers` 校验页面 framework（预注册面兜底）
- [x] 4.3 `pnpm --filter @webassistant/wc-runtime-core test` 全绿（118 通过，既有断言零改动）

## 5. 规则与文档

- [x] 5.1 `demo-app/rules/domain.md`：`/lab` 用语改为「打开能力验收室」
- [x] 5.2 `README.md`：删 `analyze:host` 行与 `/wc-ce` 引用；核心机制新增「一份清单、两条渲染面」
- [x] 5.3 `PROJECT.md`：目录树、§5.1 / §5.3（顺带修正为 WS 现实，删掉 `agentBase`/SSE 残述）、
      §6.9 对照表与接入段、§八 运行方式；坑表新增 3 行（tag 含 `-`、host 面资产归一化、8080 旧实例占端口）
- [x] 5.4 `docs/INTEGRATION_GUIDE.md` §9：9.1/9.2/9.3/9.4/9.6/9.7 —— 删 `analyze:host` 与 `wc.host.json` 段、
      接线示例改为 binding、部署物表按「同一份 manifest」重写、新增硬规矩第 8 条
- [x] 5.5 `docs/agent-session.md`：`dataSources` 声明位置去掉「或 host 批次的 `wc.host.json`」
- [x] 5.6 `packages/demo-app/README.md`、`packages/wc-runtime-vue/README.md`：同步
- [x] 5.7 changeset：`.changeset/unify-page-manifest-and-host-binding.md`（core patch / vue minor / analyzer patch）

## 6. 验证

- [x] 6.1 `pnpm typecheck` 全绿（8/8 包）
- [x] 6.2 `pnpm analyze` → 结构与预期一致（`containers.vue` + 7 页全带 bundle，与 `dist-ce/pages/**` 7/7 对齐）；
      ⚠️ 与「改动前」的逐字节 diff 不可得（产物未入库 + 工作区本就有未提交改动）→ 等价性由 4.2 的单测锁定
- [x] 6.3 `pnpm build:ce` → `dist-ce/pages/appDashboard.js` / `orderList.js` 存在（7 个页面产物齐）
- [x] 6.4 `pnpm test` 全绿（core 118 / vue 39 / chat-client 24 / analyzer 28 / agent-server 18）
- [x] 6.5 静态与 dev 两条路径都冒烟：8080（`serve.mjs`）与 5173/5199（vite 中间件）上
      `/wc/manifest.json`、`/wc/dist-ce/pages/appDashboard.js`、`/wc/dist-ce/containers/vue.js` 均 200，
      `/wc-ce/manifest.json` 404
- [x] 6.6 `grep -rn '/wc-ce\|analyze:host\|wc.host.json'` 仅剩 1 处（文档里那句「不需要 `wc.host.json`」）
- [x] 6.7 host 面消费容器形状 manifest 的**端到端**验证（落成回归测试而非一次性手测）：
      `wc-runtime-vue/test/hostSurface.test.js` 新增「直接消费容器形状的 manifest」——
      完整 `runtime.init()` 后页面目录照旧、每页 `bundle === ''`、`adopt` 生效、agent 导航落到宿主真实 router；
      另在 dev server 上确认 `AssistantDock.vue` 等模块转译通过（binding 从 `dist/hostRouter.js` 正常取出）
- [ ] 6.8 接 agent-server（需 `DEEPSEEK_API_KEY`）跑 §9.7 完整验收清单 —— 留待人工
      （浏览器自动化在本机不可用：Chrome 实例已占用 MCP profile）

