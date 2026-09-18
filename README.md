# webassistant

对话式 Web 助手：把现有项目的路由页面编译成 Web Component，由 runtime 动态路由/渲染，
Agent 可通过对话按需推送页面。页面里的 `router.push` 与 agent 的指令汇入**同一个真相源**。

## 包结构

```
packages/
├── protocol/         # 跳包契约：wc.pages.json / manifest v2 / SSE / page-event（纯类型，零依赖）
├── wc-runtime-core/  # 框架无关的 runtime 定义层（不对外）：导航/加载/容器/样式/服务/事件
├── wc-runtime-vue/   # Vue 实现 + 唤一对外门面（容器 / 页面注册 / vue-router 桥 / 服务注入）
├── vite-plugin-wc/   # 由 wc.pages.json 驱动，把一个 framework 批次编译成容器 + 页面 bundle
├── analyzer/         # 读 wc.pages.json + 页面源码（静态 + AI）→ manifest v2
├── demo-app/         # 示例「老项目」：Vue3 + element-plus，含 runtime 验收台
├── agent-server/     # Agent 后端：Cline SDK + DeepSeek，ReAct 决策 + SSE
└── chat-client/      # 前端客户端：<WebAssistant>（容器面面板）+ <HostAssistantDock>（宿主直连悬浮窗）
```

全仓 TypeScript（基线在 `tsconfig.base.json`）。

## 快速开始

```bash
pnpm install
pnpm build:libs      # 构建 protocol / core / vue / plugin / analyzer / chat-client
pnpm analyze         # 生成唯一 manifest（静态 + AI）→ packages/demo-app/public/wc/manifest.json
pnpm build:ce        # 只编译容器 + 页面为 WC（产物 packages/demo-app/dist-ce/）
pnpm typecheck       # 全仓类型检查（tsc + vue-tsc）
pnpm test            # core / vue / chat-client / analyzer / agent-server 单测

# ★ 两条渲染面**共用同一份清单与 manifest**（wc.pages.json → public/wc/manifest.json）：
#   命令只有 `analyze`（生成页面目录）+ `build:ce`（只有容器面需要的产物），没有第二遍分析。
#   详见 openspec/changes/unify-page-manifest

# ① 三条演示链路都在 demo-app 的宿主 SPA 里（一个端口 5173）
pnpm dev             # → http://localhost:5173/#/dashboard（需要 mock 后端：pnpm preview:ce）
                     #   /dashboard /users /orders /datasources /settings  业务路由 + 悬浮 dock = 用法 B（agent 直接操作宿主 router）
                     #   /assistant  路由内嵌面板        = 用法 A（容器 / WC，页面在面板内渲染）
                     #   /lab        能力验收室          = 探针集中地（浮层样式 / CSS-in-JS / 3D 图 / runtime 状态）
                     #   /login      宿主自己的路由      = 登录守卫 + token（不在 manifest）
                     #   /wc-demo.html                  = runtime 层验收台（不依赖 chat-client）
pnpm dev:agent -- --manifest-url http://localhost:5173/wc/manifest.json   # 远程（随宿主刷新）
pnpm dev:agent -- --manifest ../demo-app/public/wc/manifest.json          # 本地文件热重载
                     # 两种用法读的是**同一个文件** —— 只有失败行为不同：
                     # 远程拉取失败 = 告警并沿用旧/空 manifest；本地文件不存在 = 启动即崩。
                     # ⚠️ --manifest 的相对路径按**当前工作目录**解析，而 pnpm 跑脚本的 cwd 是
                     #    packages/agent-server，所以写 ../demo-app/...（别写 packages/demo-app/...）
                     # 先在 packages/agent-server/.env 配 DEEPSEEK_API_KEY；
                     # .env 里的 MANIFEST_URL 会被命令行参数覆盖（CLI 优先）

# ② 只跑 runtime / WC 产物验收（8080：mock API + 静态预览，不含宿主 SPA）
pnpm preview:ce      # → http://localhost:8080/ （= wc-demo.html）
```

## 核心机制（一页版）

1. **一个 framework 批次 = 一次构建**：容器（`containers/vue.js`）与页面（`pages/*.js`）必须同批构建，
   才能共享同一份框架实例（Vite 共享 chunk）；这是页面 CE 能继承容器 provide 的前提。
2. **依赖二分**：runtime 自有（vue / vue-router / element-plus）在构建期进 bundle；
   外层传入（request / t / token / state）运行时经 `services` 注入，**必须框架无关**。
3. **唤一真相源**：core 的 `NavigationController`；agent `navigate()` 与页面 `router.push()` 都汇入它
   （vue-router 桥的三个机制：路由表同步 / guard 前移 / `applying` 计数器防回环）。
4. **隔离边界**：每个容器 WC 自己的 shadow root；业务页面用 `shadowRoot:false` 渲染在其中。
   UI 库浮层 teleport 到 body 是已知泄漏点 → `lightDomStyles` 补一份光 DOM 样式。
5. **props 走 property**：core 把 `params` + 声明 props + 直传 props 归一后下发，对象不能经 attribute。
6. **一份清单、两条渲染面**：`wc.pages.json` → **一份** `manifest.json`（容器形状）。容器面（用法 A）读其中的
   `containers` / `pages[].bundle`；宿主直连面（用法 B）只读页面目录，WC 资产由 core 归一化为空
   （`forHostSurface`）。因此没有第二份清单、也没有第二次分析命令。

详细设计与踩坑记录见 [PROJECT.md](./PROJECT.md)；各包契约见各自 README。
