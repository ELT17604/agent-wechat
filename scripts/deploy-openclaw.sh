#!/usr/bin/env bash
set -euo pipefail

# Deploy the OpenClaw WeChat extension to an OpenClaw extensions directory.
# Usage: pnpm deploy:openclaw [target_dir]
#   target_dir defaults to ../openclaw/extensions/wechat

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$ROOT_DIR/packages/openclaw-extension"

TARGET="${1:-$ROOT_DIR/../openclaw/extensions/wechat}"

# Build first
echo "Building..."
pnpm build

# Copy extension files
echo "Deploying to $TARGET"
mkdir -p "$TARGET/dist"
cp "$EXT_DIR/dist/index.js" "$TARGET/dist/index.js"
# Strip dependencies/devDependencies — esbuild bundles everything into dist/index.js
# so workspace:* refs would break in openclaw's pnpm workspace
jq 'del(.dependencies, .devDependencies)' "$EXT_DIR/package.json" > "$TARGET/package.json"
cp "$EXT_DIR/openclaw.plugin.json" "$TARGET/openclaw.plugin.json"

echo "Done."
