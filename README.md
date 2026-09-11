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
└── chat-client/      # 前端客户端：<WebAssistant> 组件（对话 + 渲染）
```

全仓 TypeScript（基线在 `tsconfig.base.json`）。

## 快速开始

```bash
pnpm install
pnpm build:libs      # 构建 protocol / core / vue / plugin / analyzer
pnpm build:ce        # 只编译容器 + 页面为 WC（产物 packages/demo-app/dist-ce/）
pnpm analyze         # 独立执行静态 + AI 分析，读取宿主 .env/.env.local，生成/更新 manifest v2（带项目级缓存）
pnpm typecheck       # 全仓类型检查（tsc + vue-tsc）
pnpm test            # core / vue 单测

# 方式 A：runtime 验收台（不依赖 chat-client，验证构建产物最快）
pnpm preview:ce      # → http://localhost:8080/

# 方式 B：完整对话链路（三个终端）
pnpm preview:ce      # 8080 静态服务器（manifest + WC 产物）
pnpm dev:agent       # 3000 agent-server（先在 packages/agent-server/.env 配 DEEPSEEK_API_KEY）
pnpm dev:client      # 5173 chat-client（proxy /wc→8080、/api→3000）

# 单独验证页面功能（普通 SPA）
pnpm dev
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

详细设计与踩坑记录见 [PROJECT.md](./PROJECT.md)；各包契约见各自 README。
