#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DOCKER_DIR="$ROOT_DIR/docker"
DOCKERFILE="$DOCKER_DIR/Dockerfile"
CACHE_DIR="$DOCKER_DIR/cache"
DEB_PATH="$DOCKER_DIR/wechat.deb"

AMD64_URL="https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb"
ARM64_URL="https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_arm64.deb"

FORCE=0
ARCH_ONLY=""
NO_CACHE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-cache)
      NO_CACHE=1
      shift
      ;;
    --arch)
      ARCH_ONLY="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

download_file() {
  local url="$1"
  local cache_path="$2"
  local temp_path="${cache_path}.partial"

  if [ "$FORCE" -eq 1 ]; then
    echo "==> Forcing download of $(basename "$cache_path")"
  fi

  echo "==> Downloading $(basename "$cache_path")"
  mkdir -p "$CACHE_DIR"
  rm -f "$temp_path"
  if command -v curl >/dev/null 2>&1; then
    curl -L "$url" -o "$temp_path"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$temp_path" "$url"
  else
    echo "curl or wget is required" >&2
    exit 1
  fi
  mv "$temp_path" "$cache_path"
}

ensure_download() {
  local url="$1"
  local cache_path="$2"

  if [ -f "$cache_path" ] && [ "$FORCE" -eq 0 ]; then
    local size
    size=$(wc -c < "$cache_path" | tr -d ' ')
    if [ "${size}" -gt 10485760 ]; then
      echo "==> Using cached $(basename "$cache_path") (${size} bytes)"
      return
    fi
    echo "==> Cached file too small (${size} bytes), re-downloading"
  fi

  download_file "$url" "$cache_path"
}

prepare_build_context() {
  echo "==> Preparing build context"

  # Build TypeScript packages first
  echo "==> Building packages..."
  pnpm build

  # Copy shared package to docker context
  echo "==> Copying shared package to docker context"
  mkdir -p "$DOCKER_DIR/shared"
  cp -r "$ROOT_DIR/packages/shared/dist" "$DOCKER_DIR/shared/"
  cp "$ROOT_DIR/packages/shared/package.json" "$DOCKER_DIR/shared/"

  # Copy agent-server to docker context
  echo "==> Copying agent-server to docker context"
  mkdir -p "$DOCKER_DIR/agent-server"
  cp -r "$ROOT_DIR/packages/agent-server/dist" "$DOCKER_DIR/agent-server/"

  # Copy package.json and replace workspace: with file: protocol
  sed 's|"workspace:\*"|"file:/opt/shared"|g' \
    "$ROOT_DIR/packages/agent-server/package.json" > "$DOCKER_DIR/agent-server/package.json"
}

build_arch() {
  local arch="${1:-}"
  local url="${2:-}"
  local platform="${3:-}"
  local tag="${4:-}"
  local cache_path="${5:-}"

  if [ -z "$arch" ] || [ -z "$url" ] || [ -z "$platform" ] || [ -z "$tag" ] || [ -z "$cache_path" ]; then
    echo "build_arch missing args" >&2
    exit 1
  fi

  ensure_download "$url" "$cache_path"

  echo "==> Building ${tag} (${platform})"
  cp "$cache_path" "$DEB_PATH"
  docker buildx build \
    ${NO_CACHE:+--no-cache} \
    --platform "$platform" \
    -t "$tag" \
    --load \
    -f "$DOCKERFILE" \
    "$DOCKER_DIR"
}

# Prepare build context (build TS and copy files)
prepare_build_context

if [ -z "$ARCH_ONLY" ]; then
  build_arch "amd64" "$AMD64_URL" "linux/amd64" "agent-wechat:amd64" "$CACHE_DIR/wechat.amd64.deb"
  build_arch "arm64" "$ARM64_URL" "linux/arm64" "agent-wechat:arm64" "$CACHE_DIR/wechat.arm64.deb"
  printf "\nDone. Built: agent-wechat:amd64, agent-wechat:arm64\n"
else
  case "$ARCH_ONLY" in
    amd64)
      build_arch "amd64" "$AMD64_URL" "linux/amd64" "agent-wechat:amd64" "$CACHE_DIR/wechat.amd64.deb"
      printf "\nDone. Built: agent-wechat:amd64\n"
      ;;
    arm64)
      build_arch "arm64" "$ARM64_URL" "linux/arm64" "agent-wechat:arm64" "$CACHE_DIR/wechat.arm64.deb"
      printf "\nDone. Built: agent-wechat:arm64\n"
      ;;
    *)
      echo "unsupported arch: $ARCH_ONLY (use amd64 or arm64)" >&2
      exit 1
      ;;
  esac
fi
