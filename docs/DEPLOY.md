# 部署：公开 demo（全免费）

把 **demo-app**（静态站点 + `/api` mock 后端）与 **agent-server**（Node + WebSocket）发布到公网，
任何人打开就能与助手对话。全程使用免费额度：

| 能力 | 平台 | 为什么免费 |
|---|---|---|
| CI / 构建 | GitHub Actions | 公开仓库不限分钟 |
| 静态站点 + `/api` | Cloudflare Pages（+ Functions） | 静态请求免费无限；Functions 计入 Workers 免费额度（10 万请求/天）|
| 容器镜像仓库 | GitHub Container Registry（GHCR） | 公开包免费 |
| agent-server | Render 免费 Web Service（Docker） | 免费实例；**闲时休眠**（见 §5）|

## 0. 架构

```
                    ┌────────── Cloudflare Pages（站点内同源）──────────┐
浏览器 ─── HTTPS ──► │  /            demo-app/dist 静态（SPA）              │
                    │  /wc/**       manifest.json + dist-ce/**             │
                    │  /api/**      Pages Function（mock 后端）            │
                    └─────────────────────────────────────────────────────┘
       ─── wss:// ─► wss://<agent-server 域名>/ws      ← 跨域，构建期 VITE_WS_BASE 注入
                    ┌────────── Render 免费 Web Service ──────────────────┐
CI / Render ──────► │  agent-server（GHCR 镜像 · linux/amd64 · WebSocket） │
                    │   MANIFEST_URL = https://<pages 域名>/wc/manifest.json │
                    └─────────────────────────────────────────────────────┘
```

## 1. 两个部署单元与产物

| 部署单元 | 平台 | 构建入口 | 产物 |
|---|---|---|---|
| demo-app（静态 + mock API） | Cloudflare Pages | `pnpm build:demo` | `packages/demo-app/dist/`（`index.html` + `assets/` + `wc/manifest.json` + `wc/dist-ce/**`）；`/api` 由 `packages/demo-app/functions/` 的 Pages Function 承担 |
| agent-server | Render | `packages/agent-server/Dockerfile`（CI 构建 → GHCR） | 镜像 `ghcr.io/<owner>/<repo>/agent-server:latest` |

> **不用 GitHub Pages**：Pages 项目站点在子路径 `/<repo>/`（要连带改 `base`/`wc-base`），且不能承载
> `/api` 与 `/ws`。Cloudflare Pages 站点在**域名根**、且 Functions 与静态同源，正好匹配当前代码。

## 2. 一次性设置

### 2.1 账号
- **Cloudflare**（Pages + Functions）
- **Render**（Web Service）
- （可选）**DeepSeek API Key** —— 只影响 `analyze` 的 AI 关键词，无 key 会回退静态解析

### 2.2 建 Cloudflare Pages 项目
```bash
npx wrangler login
npx wrangler pages project create web-assistant --production-branch=main
```
（也可跳过，首次 `wrangler pages deploy` 会自动创建。）
记下站点地址：`https://<project>.pages.dev`。

### 2.3 建 Render Web Service（agent-server）
Render 面板 → **New → Web Service → Existing Image**：
- **Image URL**：`ghcr.io/<owner>/<repo>/agent-server:latest`
- **环境变量**：
  - `DEEPSEEK_API_KEY` = `<你的 key>`
  - `MANIFEST_URL` = `https://<project>.pages.dev/wc/manifest.json`
- 记下服务地址 `https://<service>.onrender.com`；在 **Settings → Deploy Hook** 复制 hook URL

### 2.4 把 GHCR 包设为公开
首次由 workflow 推送镜像后：GitHub → 仓库 → **Packages** → `web-assistant/agent-server`
→ **Package settings → Change visibility → Public**。
（不公开也可以，但要改用 Render 的私有镜像凭据。）

### 2.5 配仓库 Secret / Variable
仓库 → **Settings → Secrets and variables → Actions**：

| 类型 | 名称 | 值 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（权限含 **Cloudflare Pages: Edit**）|
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID（面板右侧，或 `npx wrangler whoami`）|
| Secret | `RENDER_DEPLOY_HOOK_URL` | §2.3 的 Deploy Hook URL |
| Secret | `DEEPSEEK_API_KEY` | （可选）给 CI 里的 `analyze` 用 |
| Variable | `VITE_WS_BASE` | `wss://<service>.onrender.com/ws` |

> ⚠️ `VITE_WS_BASE` 不配会回退成 `/ws`（同源）—— Pages 上没有 `/ws` 后端，助手会连不上。

## 3. 日常发布

推送到 `main` 即自动构建与发布：
- `packages/**` 变动 → **Deploy demo-app**（`pnpm build:demo` → `wrangler pages deploy dist`）
- `packages/agent-server/**` 或 `packages/protocol/**` 变动 → **Deploy agent-server**（镜像 → GHCR → Render）
- 也可在 **Actions** 页手动 `Run workflow`

本地等价命令：
```bash
pnpm build:demo                                   # 产出 packages/demo-app/dist/
npx wrangler pages dev packages/demo-app/dist     # 本地跑「静态 + /api Function」（需先 build:demo）
pnpm dev:agent -- --manifest-url http://localhost:5173/wc/manifest.json   # 本地跑 agent-server
```

> 旧的**内网服务器**路径仍在（`deploy.sh` + `docker-compose.yml`：tar.gz → `docker load` → `docker run`），
> 适合私有部署；本文档描述的是公开 demo 的免费路径。

## 4. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 页面能开、助手连不上 | `VITE_WS_BASE` 缺失或填错；看构建日志，或直接 grep 产物 JS 是否含你的域名 |
| 首次发言等 30~60s | Render 免费实例闲时休眠，冷启动（见 §5）|
| `/api/**` 返回 404 | Functions 目录没跟部署根同级：确认存在 `packages/demo-app/functions/api/[[path]].js` |
| agent 不认任何页面 | Render 上 `MANIFEST_URL` 指错（应指向 Pages 的 `/wc/manifest.json`）|
| 新建数据源后刷新没了 | Pages Function 无状态（见 §5）|

## 5. 已知取舍（免费版）

1. **Render 免费实例闲时休眠**：一段时间无人访问后，首个请求要冷启动（数十秒）。要常驻需付费。
2. **Pages Function 无状态**：`/api` 的写操作（`POST /api/datasources`、`PUT /api/settings`）只在当前
   isolate 生命周期内可见，刷新 / 换 isolate 后回到种子数据。演示可接受；要持久化可接 Cloudflare KV/D1。
3. **WS 跨域**：静态在 Pages、后端在 Render ⇒ 必须用 `VITE_WS_BASE` 绝对地址。
4. **`analyze` 的 AI 关键词**：CI 未配 `DEEPSEEK_API_KEY` 时回退静态解析（keywords 为空），功能不受影响。
5. **首次部署顺序**：先跑 **Deploy agent-server**（镜像进 GHCR）→ 把包设为 Public → 在 Render 建服务；
   然后再跑 **Deploy demo-app**（此时 `VITE_WS_BASE` 才有值可填）。
