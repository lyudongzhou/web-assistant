// agent-server 的 WebSocket 地址前缀 —— 两个助手面板（用法 A / 用法 B）共用，单一来源。
//
// 取值：构建期环境变量 VITE_WS_BASE，缺省 '/ws'。
//   - 本地 dev：'/ws' → vite 代理到 ws://localhost:3000（见 vite.config.ts 的 server.proxy）
//   - 生产（静态站点与 agent-server **不同域**，例如 Pages + Render）：填绝对地址，
//     如 wss://xxx.onrender.com/ws —— chat-client 的 wsUrl() 支持 http(s):// 与 ws(s):// 绝对地址
//
// 说明：只配 WS，不配 /api —— /api 走同源（本地 vite 代理、线上 Cloudflare Pages Function）；
//       wc-base 也保持缺省 '/wc'（站点部署在域名根）。
export const wsBase: string = import.meta.env.VITE_WS_BASE || '/ws'
