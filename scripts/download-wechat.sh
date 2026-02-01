#!/usr/bin/env bash
set -euo pipefail

ARCH=${1:-""}
TARGET_DIR=${2:-"docker"}

if [ -z "$ARCH" ]; then
  ARCH=$(uname -m)
fi

URL=""
case "$ARCH" in
  x86_64|amd64)
    URL="https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb"
    ;;
  aarch64|arm64)
    URL="https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_arm64.deb"
    ;;
  *)
    echo "unsupported architecture: $ARCH" >&2
    exit 1
    ;;
 esac

mkdir -p "$TARGET_DIR"
OUT_PATH="$TARGET_DIR/wechat.deb"

if command -v curl >/dev/null 2>&1; then
  curl -L "$URL" -o "$OUT_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$OUT_PATH" "$URL"
else
  echo "curl or wget is required" >&2
  exit 1
fi

echo "Downloaded $URL to $OUT_PATH"
