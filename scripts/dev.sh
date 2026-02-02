#!/bin/bash
#
# Start the agent-wechat container in dev mode with hot reload
#
# Usage: pnpm dev
#
# This mounts local dist folders into the container so changes
# rebuild via 'pnpm build:watch' are reflected immediately.
#

set -e

CONTAINER_NAME="agent-wechat"
DEFAULT_PORT=6174
VNC_PORT=5900
DEBUG_PORT=9229

# Determine architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  IMAGE="agent-wechat:arm64"
else
  IMAGE="agent-wechat:amd64"
fi

# Get script directory and monorepo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Paths to mount
AGENT_SERVER_DIST="$MONOREPO_ROOT/packages/agent-server/dist"
SHARED_DIST="$MONOREPO_ROOT/packages/shared/dist"
DOCKER_TOOLS="$MONOREPO_ROOT/docker/tools"

# Stop any existing container
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

# Check if image exists
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Error: Image $IMAGE not found."
  echo "Run 'pnpm build:image:local' first to build the image."
  exit 1
fi

# Check if dist folders exist
if [ ! -d "$AGENT_SERVER_DIST" ] || [ ! -d "$SHARED_DIST" ]; then
  echo "Error: dist/ folders not found. Run 'pnpm build' first."
  exit 1
fi

echo "Starting $CONTAINER_NAME in dev mode..."
echo "  Mounting: $AGENT_SERVER_DIST"
echo "  Mounting: $SHARED_DIST"
echo "  Mounting: $DOCKER_TOOLS"

docker run -d \
  --name "$CONTAINER_NAME" \
  --security-opt seccomp=unconfined \
  -p "$DEFAULT_PORT:$DEFAULT_PORT" \
  -p "$VNC_PORT:$VNC_PORT" \
  -p "$DEBUG_PORT:$DEBUG_PORT" \
  -v "$CONTAINER_NAME-data:/data" \
  -v "$AGENT_SERVER_DIST:/opt/agent-server/dist" \
  -v "$SHARED_DIST:/opt/shared/dist" \
  -v "$DOCKER_TOOLS:/opt/tools" \
  -e "NODE_OPTIONS=--inspect=0.0.0.0:$DEBUG_PORT" \
  -e "DEV_MODE=1" \
  "$IMAGE"

echo ""
echo "Dev container started!"
echo "  API: http://localhost:$DEFAULT_PORT"
echo "  VNC: localhost:$VNC_PORT"
echo "  Debug: localhost:$DEBUG_PORT"
echo ""
echo "Waiting for server..."

for i in {1..30}; do
  if curl -s "http://localhost:$DEFAULT_PORT/health" >/dev/null 2>&1; then
    echo "Server is ready!"
    echo ""
    echo "Dev mode active:"
    echo "  - Run 'pnpm build:watch' for hot reload"
    echo "  - Attach VS Code debugger to port $DEBUG_PORT"
    exit 0
  fi
  sleep 1
  printf "."
done

echo ""
echo "Server did not become ready in time. Check logs with: pnpm cli logs"
exit 1
