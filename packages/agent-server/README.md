# agent-server

基于 NestJS（Fastify）的 Agent 网关服务：提供 HTTP + WebSocket 入口，拉取页面 manifest，并驱动 Cline SDK 完成「对话式 Web 助手」的 Agent 决策与页面操作。

## 容器化运行

镜像为多阶段构建，构建上下文必须是**仓库根目录**（需编译 workspace 依赖 `@webassistant/protocol`）。

### 构建

```bash
docker build -f packages/agent-server/Dockerfile -t agent-server .
```

默认使用私有 npm registry `http://172.16.21.103:4873/`；如在其它网络环境构建，可覆盖：

```bash
docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org/ \
  -f packages/agent-server/Dockerfile -t agent-server .
```

### 构建（一键脚本）

`packages/agent-server/build-image.sh`：固定 **linux/amd64** 构建，并把镜像 `docker save | gzip`
成文件（默认 `agent-server-amd64.tar.gz`，落在仓库根目录），供离线部署。构建**不需要任何环境变量**
（环境变量仅在运行/部署容器时需要，见下文「环境变量」）。

```bash
packages/agent-server/build-image.sh                   # 构建 + 导出 agent-server-amd64.tar.gz
packages/agent-server/build-image.sh -t agent-server:local -o /tmp/agent-server.tar.gz
packages/agent-server/build-image.sh --no-save         # 只构建，不导出
packages/agent-server/build-image.sh --no-cache        # 不用缓存重建
packages/agent-server/build-image.sh --platform ""     # 按宿主平台构建（默认 amd64 交叉）
packages/agent-server/build-image.sh --registry https://registry.npmjs.org/   # 走公共源
```

等价于在包内执行 `pnpm --filter agent-server docker:build`。

### 运行

服务需要页面 manifest 与 `DEEPSEEK_API_KEY` 才能工作：

- **远程 manifest（`MANIFEST_URL`）**：启动先拉一次，**拉不到不退出**，之后每 `MANIFEST_REFRESH_INTERVAL_MS`（默认 1 分钟）重试；拉到后也会按该间隔持续刷新。
- **本地 manifest（`MANIFEST_PATH`）**：挂载文件 + mtime 热重载；文件缺失属于配置错误，会启动失败。
- 二者都未配置时，容器内默认 manifest 路径不存在，会启动失败。

```bash
# 方式一：manifest 通过 HTTP 拉取
docker run --rm -p 3000:3000 \
  -e DEEPSEEK_API_KEY=sk-xxx \
  -e MANIFEST_URL=http://localhost:5778/wc/manifest.json \
  agent-server

# 方式二：挂载本地 manifest 文件
docker run --rm -p 3000:3000 \
  -e DEEPSEEK_API_KEY=sk-xxx \
  -v /abs/path/to/manifest.json:/manifest.json:ro \
  -e MANIFEST_PATH=/manifest.json \
  agent-server
```

### 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | — | DeepSeek API Key |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com/v1` | API 地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-chat` | 模型 |
| `PORT` | 否 | `3000` | 监听端口 |
| `MANIFEST_URL` | 是* | — | 启动时通过 HTTP 拉取 manifest（优先于 `MANIFEST_PATH`），失败不退出、按 `MANIFEST_REFRESH_INTERVAL_MS` 重试，成功后定期刷新 |
| `MANIFEST_PATH` | 是* | — | manifest 本地文件绝对路径（未配置 `MANIFEST_URL` 时生效） |
| `MANIFEST_FETCH_TIMEOUT_MS` | 否 | `8000` | 远程拉取超时 |
| `MANIFEST_REFRESH_INTERVAL_MS` | 否 | `60000` | 远程 manifest 刷新/重试间隔（ms） |
| `MANIFEST_INSECURE_TLS` | 否 | — | manifest 为自签 HTTPS 时设 `1` 跳过 TLS 校验（仅 manifest 拉取生效，不影响 DeepSeek） |
| `HTTP_PROXY` | 否* | — | 服务器无法直连公网时必填，DeepSeek 请求走该 HTTP 代理 |
| `HTTPS_PROXY` | 否* | — | 同上（值仍用 `http://` 代理地址，HTTPS 走 CONNECT 隧道） |
| `NO_PROXY` | 否* | — | 不走代理的地址列表，须包含 manifest 主机与 `localhost` |
| `MAX_AGENT_STEPS` | 否 | `6` | 单轮 ReAct 最大步数 |
| `TOOL_CALL_TIMEOUT_MS` | 否 | `8000` | 单次 `tool.call`（`render` / `call_page_method`）超时 |
| `OBSERVATION_WAIT_TIMEOUT_MS` | 否 | `10000` | `wait_for_observation` 等待观测的默认超时（也是上限） |
| `AGENT_RUN_TIMEOUT_MS` | 否 | `60000` | 单轮 agent run 的总时长上限 |
| `SESSION_TTL_MS` | 否 | `1800000` | session 空闲回收阈值（默认 30 分钟） |

\* `MANIFEST_URL` 与 `MANIFEST_PATH` 二选一，二者都未配置时容器内会因找不到默认 manifest 而启动失败。
\* `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`：服务器无法直连公网时必填，见下文「代理」。

### 代理（服务器无法直连公网时）

agent-server 唯一需要公网的调用是 **DeepSeek API**（`@cline/sdk` → Vercel AI SDK → Node 全局 `fetch`）。Node 的 `fetch` 不会自动读取代理环境变量，服务启动时会显式挂一个 undici 全局 dispatcher：**设置了 `HTTP_PROXY` / `HTTPS_PROXY` 才启用**，未设置则保持直连（本地开发无影响）。

```bash
docker run -d --name agent-server -p 3000:3000 \
  -e DEEPSEEK_API_KEY=sk-xxx \
  -e MANIFEST_URL=http://<内网manifest主机>:8080/manifest.json \
  -e HTTP_PROXY=http://10.126.138.71:3128 \
  -e HTTPS_PROXY=http://10.126.138.71:3128 \
  -e NO_PROXY=localhost,127.0.0.1,<内网manifest主机> \
  agent-server
```

要点：

- `HTTPS_PROXY` 用 `http://10.126.138.71:3128`（HTTP 代理，DeepSeek 的 HTTPS 走它的 CONNECT 隧道），别写成 `https://`。
- **`NO_PROXY` 必须包含 manifest 主机**（以及 `localhost`）：manifest 走内网、不需要代理；否则启动拉 manifest 也会被代理拦掉。
- 构建阶段走私有 registry `172.16.21.103:4873`（内网），不需要代理；只有 runtime 阶段调 DeepSeek 需要。

### 用 docker-compose 运行（服务器上已有镜像）

`docker-compose.yml` 只**运行既有镜像**（不构建）。前置：镜像已在目标机（如 `deploy.sh` 上传 tar.gz 后 `docker load`，tag = `agent-server:amd64`）：

```bash
docker images | grep agent-server      # 确认镜像/标签已存在
cp .env.deploy.example .env.deploy     # 填 DEEPSEEK_API_KEY / MANIFEST_URL / 代理 等
docker compose up -d                   # 启动
docker compose logs -f                 # 看日志
curl http://localhost:3000/health      # => {"ok":true,"hasApiKey":true}
docker compose down                    # 停止
```

- 镜像 tag 不同则覆盖：`IMAGE=your/tag docker compose up -d`
- 宿主机端口用 `HOST_PORT` 控制（默认 `3000`）：`HOST_PORT=19400 docker compose up -d`
- 运行时配置/密钥走 `.env.deploy`（模板 `.env.deploy.example`，已被 `.gitignore` 忽略）。
- 需要本地 manifest 文件时，在 `docker-compose.yml` 里取消 `volumes` 注释挂载并设 `MANIFEST_PATH`。



### 部署到服务器（deploy.sh）

仓库根目录提供 `deploy.sh`，用于把 amd64 镜像上传到远程 Linux 服务器并（重新）运行：

```bash
export SERVER_HOST=<服务器IP>      # 或直接编辑 deploy.sh 顶部
export DEEPSEEK_API_KEY=sk-xxx     # 或创建 .env.deploy
./deploy.sh --build                # 首次/改代码后：交叉构建 + 上传 + 部署
./deploy.sh                        # 镜像没变时，仅重新上传部署
```

脚本会依次执行：`scp` 上传 tar.gz → 服务器 `docker load` → `docker rm -f` + `docker run`（默认已带 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 与 `MANIFEST_INSECURE_TLS=1`）→ 打印容器状态与 `/health`。

### 健康检查

```bash
curl http://localhost:3000/health
# => {"ok":true,"hasApiKey":true}
```

端口 `3000` 同时承载 HTTP 与 WebSocket（`DirectWsAdapter`）。
