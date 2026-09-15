#!/usr/bin/env bash
#
# 构建 agent-server 容器镜像（默认 linux/amd64）并**压缩导出成文件**，供离线部署。
#
#   - 只构建 + 导出，不做上传/部署；上传部署见仓库根目录 deploy.sh。
#   - **构建不需要任何环境变量**；环境变量是运行/部署容器时才需要，见
#     packages/agent-server/README.md「环境变量」表与 .env.example。
#
# 产物：agent-server-amd64.tar.gz（docker save <tag> | gzip）
#
# 用法：
#   packages/agent-server/build-image.sh [选项]
#     -t, --tag <tag>        镜像 tag（默认 agent-server:amd64）
#     -o, --output <file>    导出文件名（默认 <name>-<tag>.tar.gz，落在仓库根目录）
#     -p, --platform <plat>  目标平台（默认 linux/amd64；传 "" 按宿主平台构建）
#         --registry <url>   构建用 npm registry（默认 http://172.16.21.103:4873/）
#         --no-save          只构建，不导出文件
#         --no-cache         docker build --no-cache
#     -h, --help             显示本帮助
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

IMAGE_TAG="agent-server:amd64"
PLATFORM="linux/amd64"
NPM_REGISTRY="https://registry.npmjs.org/"
OUTPUT=""
DO_SAVE=1
NO_CACHE=0

default_output() {
  # agent-server:amd64 -> agent-server-amd64.tar.gz（取 basename，兼容带 registry 前缀的 tag）
  local name tag
  name="$(basename "${IMAGE_TAG%%:*}")"
  tag="${IMAGE_TAG##*:}"
  printf '%s-%s.tar.gz' "$name" "$tag"
}

usage() {
  cat <<'EOF'
构建 agent-server 容器镜像（默认 linux/amd64）并压缩导出成文件，供离线部署。

用法：
  packages/agent-server/build-image.sh [选项]

选项：
  -t, --tag <tag>        镜像 tag（默认 agent-server:amd64）
  -o, --output <file>    导出文件名（默认 <name>-<tag>.tar.gz，落在仓库根目录）
  -p, --platform <plat>  目标平台（默认 linux/amd64；传 "" 按宿主平台构建）
      --registry <url>   构建用 npm registry（默认 http://172.16.21.103:4873/）
      --no-save          只构建，不导出文件
      --no-cache         docker build --no-cache
  -h, --help             显示本帮助

说明：docker build 不需要环境变量；运行/部署容器所需的环境变量见
      packages/agent-server/README.md「环境变量」表与 packages/agent-server/.env.example。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tag) IMAGE_TAG="${2:?缺少 <tag>}"; shift 2 ;;
    -o|--output) OUTPUT="${2:?缺少 <file>}"; shift 2 ;;
    -p|--platform) PLATFORM="${2-}"; shift 2 ;;
    --registry) NPM_REGISTRY="${2:?缺少 <url>}"; shift 2 ;;
    --no-save) DO_SAVE=0; shift ;;
    --no-cache) NO_CACHE=1; shift ;;
    --) shift ;;   # 兼容 `pnpm run <script> -- <args>` 透传时多出的 `--`
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1（用 --help 查看用法）" >&2; exit 1 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "❌ 未找到 docker，请先安装 Docker" >&2; exit 1; }

echo "==> 构建镜像 ${IMAGE_TAG}（context = ${REPO_ROOT}）"
args=(build -f packages/agent-server/Dockerfile -t "${IMAGE_TAG}" --build-arg "NPM_REGISTRY=${NPM_REGISTRY}")
[[ -n "${PLATFORM}" ]] && args+=(--platform "${PLATFORM}")
[[ "${NO_CACHE}" == "1" ]] && args+=(--no-cache)

(cd "${REPO_ROOT}" && docker "${args[@]}" .)
echo "✅ 镜像已构建：${IMAGE_TAG}"

if [[ "${DO_SAVE}" == "1" ]]; then
  [[ -z "${OUTPUT}" ]] && OUTPUT="$(default_output)"
  case "${OUTPUT}" in
    /*) out="${OUTPUT}" ;;
    *)  out="${REPO_ROOT}/${OUTPUT}" ;;
  esac
  echo "==> 导出（docker save | gzip）→ ${out}"
  docker save "${IMAGE_TAG}" | gzip > "${out}"
  echo "✅ 已生成 ${out}"
fi
