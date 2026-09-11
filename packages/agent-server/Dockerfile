# ============================================================
# agent-server 容器镜像（多阶段构建）
#
# 构建上下文必须是仓库根目录（需编译 workspace 依赖 @webassistant/protocol）：
#   docker build -f packages/agent-server/Dockerfile -t agent-server .
#
# 覆盖私有 npm registry：
#   docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org/ \
#     -f packages/agent-server/Dockerfile -t agent-server .
# ============================================================

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# 私有 npm registry，可用 --build-arg 覆盖
ARG NPM_REGISTRY=http://172.16.21.103:4873/

# 先设置 registry，再安装 pnpm（避免走被墙的官方源）；同时让 pnpm 也指向同一源
RUN npm config set registry "${NPM_REGISTRY}" \
 && npm i -g pnpm@11.5.1 \
 && pnpm config set registry "${NPM_REGISTRY}"

# 1) 先拷贝 workspace 清单，依赖层可被 Docker 缓存复用
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json        packages/protocol/
COPY packages/agent-server/package.json    packages/agent-server/
COPY packages/analyzer/package.json        packages/analyzer/
COPY packages/chat-client/package.json     packages/chat-client/
COPY packages/demo-app/package.json        packages/demo-app/
COPY packages/vite-plugin-wc/package.json  packages/vite-plugin-wc/
COPY packages/wc-runtime-core/package.json packages/wc-runtime-core/
COPY packages/wc-runtime-vue/package.json  packages/wc-runtime-vue/

# 2) 只安装 agent-server 与 protocol 两个包（避免拉入 vite/vue 等无关依赖）；
#    显式列出两个包，保证它们都作为「根」安装到各自的 devDependencies（typescript 等）以便 tsc 构建
RUN pnpm install --frozen-lockfile --filter agent-server --filter @webassistant/protocol

# 3) 拷贝源码并构建（先构建零依赖的 protocol，再构建 agent-server）
COPY packages/protocol     packages/protocol
COPY packages/agent-server packages/agent-server
RUN pnpm --filter @webassistant/protocol build \
 && pnpm --filter agent-server build

# 4) 产出「自包含」的生产依赖目录 /out
#    --legacy：避免修改 pnpm-workspace.yaml（不开 inject-workspace-packages）。
#    实测（pnpm 11.5.1）legacy deploy 会把零依赖 workspace 包 @webassistant/protocol 连同其 dist
#    一并打包进 /out/node_modules/.pnpm，产物自包含、可直接运行。
#    仅清理 deploy 为「被部署包自身」留下的、指向构建机绝对路径的断链。
RUN pnpm --filter agent-server --prod --legacy deploy /out \
 && rm -f /out/node_modules/.pnpm/node_modules/agent-server

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/main.js"]
