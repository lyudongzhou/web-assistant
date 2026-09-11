#!/usr/bin/env bash
#
# agent-server 部署脚本：把 amd64 镜像上传到远程 Linux 服务器并（重新）运行。
#
# 用法：
#   ./deploy.sh             # 用当前已构建好的 agent-server-amd64.tar.gz 部署
#   ./deploy.sh --build     # 先本地交叉构建 amd64 镜像 + 打包，再部署
#
# 前置条件：
#   - 本机已安装 docker（arm64 Mac 上交叉构建需 Docker Desktop 支持 amd64 模拟）
#   - 本机能 ssh 登录服务器（建议配置免密）
#   - 服务器已安装 docker
#
# DEEPSEEK_API_KEY 的读取顺序：
#   1) 环境变量 DEEPSEEK_API_KEY
#   2) 项目根目录 .env.deploy 文件（内容形如 DEEPSEEK_API_KEY=sk-xxx，已被 .gitignore 忽略）
#
# 注意：所有配置值（API key、URL 等）请勿包含空格。
set -euo pipefail

# ======================================================================
# 配置（按你的环境改这一段即可，其余不用动）
# ======================================================================
SERVER_USER="${SERVER_USER:-root}"                 # 服务器登录用户
SERVER_HOST="${SERVER_HOST:-}"                     # 服务器 IP/域名（必填）
REMOTE_DIR="${REMOTE_DIR:-/tmp}"                   # tar.gz 上传到服务器的目录

IMAGE_TAR="${IMAGE_TAR:-agent-server-amd64.tar.gz}"  # 本地压缩包文件名
IMAGE_TAG="${IMAGE_TAG:-agent-server:amd64}"         # 镜像 tag
CONTAINER_NAME="${CONTAINER_NAME:-agent-server}"     # 容器名
HOST_PORT="${HOST_PORT:-19400}"                      # 宿主机映射端口
CONTAINER_PORT="${CONTAINER_PORT:-3000}"             # 容器内端口

MANIFEST_URL="${MANIFEST_URL:-https://172.16.21.200:19101/wc/manifest.json}"
MANIFEST_INSECURE_TLS="${MANIFEST_INSECURE_TLS:-1}"   # 1=manifest 为自签 HTTPS 时跳过 TLS 校验

# 代理（服务器无法直连公网时必填：DeepSeek 走代理；manifest 走内网，NO_PROXY 务必含 manifest 主机）
# 如需关闭代理：export HTTP_PROXY_VAL= HTTPS_PROXY_VAL= NO_PROXY_VAL=
HTTP_PROXY_VAL="${HTTP_PROXY_VAL:-http://10.126.138.71:3128}"
HTTPS_PROXY_VAL="${HTTPS_PROXY_VAL:-http://10.126.138.71:3128}"
NO_PROXY_VAL="${NO_PROXY_VAL:-localhost,127.0.0.1,172.16.21.200}"

# 构建时使用的 npm 源（本机构建连不到私有源时用公共源）
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"

# ======================================================================
# 读取 DEEPSEEK_API_KEY
# ======================================================================
if [[ -z "${DEEPSEEK_API_KEY:-}" && -f .env.deploy ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.deploy
  set +a
fi

# ======================================================================
# 参数解析
# ======================================================================
BUILD_FIRST=0
if [[ "${1:-}" == "--build" ]]; then
  BUILD_FIRST=1
fi

# ======================================================================
# 校验
# ======================================================================
if [[ -z "$SERVER_HOST" ]]; then
  echo "❌ 请先配置 SERVER_HOST（编辑脚本顶部，或用环境变量 SERVER_HOST=xxx 覆盖）" >&2
  exit 1
fi
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "❌ 缺少 DEEPSEEK_API_KEY：请 export DEEPSEEK_API_KEY=sk-xxx 或创建 .env.deploy" >&2
  exit 1
fi

SSH_TARGET="${SERVER_USER}@${SERVER_HOST}"

# ======================================================================
# 0) 可选：本地交叉构建 + 打包
# ======================================================================
if [[ "$BUILD_FIRST" == "1" ]]; then
  echo "==> [0/3] 本地交叉构建 amd64 镜像并打包"
  docker build --platform linux/amd64 \
    --build-arg NPM_REGISTRY="$NPM_REGISTRY" \
    -f packages/agent-server/Dockerfile \
    -t "$IMAGE_TAG" .
  docker save "$IMAGE_TAG" | gzip > "$IMAGE_TAR"
  echo "    已生成 $IMAGE_TAR"
fi

if [[ ! -f "$IMAGE_TAR" ]]; then
  echo "❌ 找不到 $IMAGE_TAR：请先执行 ./deploy.sh --build 生成" >&2
  exit 1
fi

# ======================================================================
# 1) 上传
# ======================================================================
echo "==> [1/3] 上传 $IMAGE_TAR 到 $SSH_TARGET:$REMOTE_DIR"
scp "$IMAGE_TAR" "$SSH_TARGET:$REMOTE_DIR/"

# ======================================================================
# 2) 服务器上加载镜像并（重新）运行容器
# ======================================================================
echo "==> [2/3] 加载镜像并重启容器"
ssh "$SSH_TARGET" 'bash -s' \
  "$DEEPSEEK_API_KEY" \
  "$MANIFEST_URL" \
  "$MANIFEST_INSECURE_TLS" \
  "$HTTP_PROXY_VAL" \
  "$HTTPS_PROXY_VAL" \
  "$NO_PROXY_VAL" \
  "$IMAGE_TAG" \
  "$CONTAINER_NAME" \
  "$HOST_PORT" \
  "$CONTAINER_PORT" \
  "$IMAGE_TAR" \
  "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
DEEPSEEK_API_KEY=$1
MANIFEST_URL=$2
MANIFEST_INSECURE_TLS=$3
HTTP_PROXY_VAL=$4
HTTPS_PROXY_VAL=$5
NO_PROXY_VAL=$6
IMAGE_TAG=$7
CONTAINER_NAME=$8
HOST_PORT=$9
CONTAINER_PORT=${10}
IMAGE_TAR=${11}
REMOTE_DIR=${12}

docker load -i "$REMOTE_DIR/$IMAGE_TAR"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# 拼装可选的代理环境变量（值为空则不加）；$PROXY_FLAGS 靠空格分词，值内不能有空格
PROXY_FLAGS=""
[[ -n "$HTTP_PROXY_VAL" ]] && PROXY_FLAGS="$PROXY_FLAGS -e HTTP_PROXY=$HTTP_PROXY_VAL"
[[ -n "$HTTPS_PROXY_VAL" ]] && PROXY_FLAGS="$PROXY_FLAGS -e HTTPS_PROXY=$HTTPS_PROXY_VAL"
[[ -n "$NO_PROXY_VAL" ]] && PROXY_FLAGS="$PROXY_FLAGS -e NO_PROXY=$NO_PROXY_VAL"

docker run -d --name "$CONTAINER_NAME" -p "$HOST_PORT:$CONTAINER_PORT" \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -e MANIFEST_URL="$MANIFEST_URL" \
  -e MANIFEST_INSECURE_TLS="$MANIFEST_INSECURE_TLS" \
  $PROXY_FLAGS \
  "$IMAGE_TAG"
REMOTE

# ======================================================================
# 3) 验证
# ======================================================================
echo "==> [3/3] 验证"
echo "    容器状态："
ssh "$SSH_TARGET" "docker ps --filter name=$CONTAINER_NAME"
echo "    健康检查："
ssh "$SSH_TARGET" "curl -s http://127.0.0.1:$HOST_PORT/health || echo '(健康接口暂未就绪，等 30s 再看)'"
echo
echo "✅ 部署完成。查看日志：ssh $SSH_TARGET 'docker logs -f $CONTAINER_NAME'"
