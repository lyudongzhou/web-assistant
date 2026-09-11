# @webassistant/protocol

跨包契约层：**纯类型 + 少量常量与命名工具，零运行时依赖**，node 侧与浏览器侧都能引用。

存在的理由：`wc.pages.json` 是「唯一真相来源」，但它的生产者与消费者散在多个包里。
把 schema 与命名规则收在这里，才能保证插件产出的路径与 analyzer 写进 manifest 的路径、
runtime 去加载的路径**永远一致**。

```
              ┌─ vite-plugin-wc  读 wcPages → 产出 containers/*.js + pages/*.js
wc.pages.json ┤
              └─ analyzer        读 wcPages → 写 manifest v2
                                                  │
                          wc-runtime-core  ────────┘ 按 manifest 加载、校验
                          agent-server     ────────┘ 读 pages[] 拼 system prompt
                          chat-client      ────────┘ WebSocket 协议
```

## 模块

| 模块 | 内容 |
|---|---|
| `wcPages.ts` | `WcPagesConfig` / `WcPageEntry`；`DEFAULT_FRAMEWORK`、`DEFAULT_PAGE_HELPER`、`CONTAINER_ENTRY_KEY`；命名工具 `toKebab` / `kebabToCamel` / `resolveTag` / `pageBundlePath` / `containerBundlePath` / `containerTagName` |
| `manifest.ts` | `RuntimeManifest`（analyzer 写出的严格格式）、`RuntimeManifestInput`（runtime 接受的宽松输入）、`ManifestPage` / `ManifestContainer` / `ManifestParam` / `ManifestProp`、`MANIFEST_VERSION = 2` |
| `sse.ts` | `AgentRenderEvent` 渲染指令类型（供 `useAgentChat` 的 tool.call 参数使用；旧 SSE 协议已废弃，对话走 `websocket.ts`） |
| `pageEvent.ts` | `PageEventPayload`（页面 emit → 容器 → runtime → 宿主 → agent） |

## 命名规则（单一来源）

```ts
resolveTag({ name: 'AppDashboard' })   // 'app-dashboard'（显式 tag 优先）
pageBundlePath('app-dashboard')        // 'pages/appDashboard.js'
containerBundlePath('vue')             // 'containers/vue.js'
containerTagName('vue')                // 'runtime-vue'
```

`wc-runtime-core` 的 `normalizeManifest`、`vite-plugin-wc` 的产物命名、`analyzer` 写入的 `bundle`
全部调用这几个函数 —— 改规则只需改这里一处。

## 约定

- 只放**类型、常量、纯函数**；任何有状态或有 IO 的东西都不属于这里
- 不依赖 vue / node / vite；`tsc` 输出 ESM，浏览器可直接加载（demo 的验收台就是这么用的）
