#!/usr/bin/env bash
set -euo pipefail

# Compile the Rust server inside Docker and deploy into a running container.
# Usage:
#   ./scripts/dev-deploy.sh                 # auto-detect everything
#   ./scripts/dev-deploy.sh --container abc # specify container name/id

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUST_DIR="$ROOT_DIR/packages/agent-server-rust"
BUILDER_IMAGE="rust:1.93-bookworm"
CACHE_VOLUME="agent-wechat-cargo-cache"

CONTAINER=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --container)
      CONTAINER="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "Usage: $0 [--container name]" >&2
      exit 1
      ;;
  esac
done

# Auto-detect container
if [ -z "$CONTAINER" ]; then
  CONTAINER=$(docker ps --filter "name=agent-wechat" --format '{{.Names}}' | head -1)
  if [ -z "$CONTAINER" ]; then
    echo "No running agent-wechat container found. Specify with --container" >&2
    exit 1
  fi
fi

# Detect container platform
CONTAINER_ARCH=$(docker inspect --format '{{.Architecture}}' "$CONTAINER" 2>/dev/null || echo "")
case "$CONTAINER_ARCH" in
  amd64)  PLATFORM="linux/amd64" ;;
  arm64)  PLATFORM="linux/arm64" ;;
  *)
    case "$(uname -m)" in
      x86_64)        PLATFORM="linux/amd64" ;;
      aarch64|arm64) PLATFORM="linux/arm64" ;;
      *) echo "Unknown architecture." >&2; exit 1 ;;
    esac
    ;;
esac

echo "==> Building in Docker ($PLATFORM)"
docker run --rm \
  --platform "$PLATFORM" \
  -v "$RUST_DIR:/build:ro" \
  -v "$CACHE_VOLUME:/build/target" \
  -v "${CACHE_VOLUME}-registry:/usr/local/cargo/registry" \
  -w /build \
  "$BUILDER_IMAGE" \
  cargo build --release

echo "==> Deploying to container: $CONTAINER"
# Extract binary from cache volume via a temporary container
TMP_CT=$(docker create -v "$CACHE_VOLUME:/target:ro" "$BUILDER_IMAGE")
docker cp "$TMP_CT:/target/release/agent-server" - | docker cp - "$CONTAINER:/opt/agent-server/"
docker rm "$TMP_CT" > /dev/null

# Kill server process — entrypoint restart loop brings it back with new binary
docker exec "$CONTAINER" pkill -f '/opt/agent-server/agent-server' 2>/dev/null || true
echo "==> Server restarting with new binary"
