#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Environment setup
# ============================================
export DISPLAY=${DISPLAY:-:99}
export QT_ACCESSIBILITY=${QT_ACCESSIBILITY:-1}
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=${QT_LINUX_ACCESSIBILITY_ALWAYS_ON:-1}
export GTK_MODULES=${GTK_MODULES:-gail:atk-bridge}
export WECHAT_HOME=${WECHAT_HOME:-/home/wechat}

# ============================================
# X11 setup
# ============================================
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /tmp/.X11-unix
  chown root:root /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix
fi

if [ -f /tmp/.X99-lock ]; then
  rm -f /tmp/.X99-lock
fi

# ============================================
# Start Xvfb
# ============================================
Xvfb "$DISPLAY" -screen 0 1280x800x24 &
sleep 1

# ============================================
# Start D-Bus session as wechat user
# This ensures AT-SPI socket is accessible to wechat
# ============================================
DBUS_OUTPUT=$(su -s /bin/bash -c "dbus-launch --sh-syntax" wechat)
eval "$DBUS_OUTPUT"
export DBUS_SESSION_BUS_ADDRESS

echo "D-Bus session (wechat user): $DBUS_SESSION_BUS_ADDRESS"

# ============================================
# Start fluxbox window manager
# ============================================
if command -v fluxbox >/dev/null 2>&1; then
  su -s /bin/bash -c "DISPLAY=$DISPLAY DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS HOME=$WECHAT_HOME fluxbox &" wechat
fi

# ============================================
# Start accessibility daemon as wechat user
# ============================================
if [ -x /usr/libexec/at-spi-bus-launcher ]; then
  su -s /bin/bash -c "DISPLAY=$DISPLAY DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS HOME=$WECHAT_HOME /usr/libexec/at-spi-bus-launcher &" wechat
  sleep 1  # Give AT-SPI time to register
fi

# ============================================
# Start VNC (optional)
# ============================================
if [ "${ENABLE_VNC:-1}" = "1" ]; then
  # -shared: allow multiple connections (needed for vncdotool)
  # -xkb: better keyboard handling
  x11vnc -display "$DISPLAY" -forever -nopw -shared -xkb -rfbport 5900 &
fi

# ============================================
# Start WeChat (background)
# Pass all required environment variables explicitly
# Disable Qt HiDPI scaling so AT-SPI coordinates match actual screen pixels
# ============================================
su -s /bin/bash -c "DISPLAY=$DISPLAY \
  DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS \
  QT_ACCESSIBILITY=1 \
  QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 \
  QT_AUTO_SCREEN_SCALE_FACTOR=0 \
  QT_ENABLE_HIGHDPI_SCALING=0 \
  QT_SCALE_FACTOR=1 \
  GTK_MODULES=gail:atk-bridge \
  HOME=$WECHAT_HOME \
  /usr/bin/wechat &" wechat

# ============================================
# Initialize SQLite database if needed
# ============================================
DB_PATH="${AGENT_DB_PATH:-/data/agent.db}"
if [ ! -f "$DB_PATH" ]; then
  echo "Initializing database at $DB_PATH..."
  mkdir -p "$(dirname "$DB_PATH")"
  chown wechat:wechat "$(dirname "$DB_PATH")"
fi

# ============================================
# Start agent-server (foreground, main process)
# ============================================
echo "Starting agent-server on port ${AGENT_PORT:-6174}..."
cd /opt/agent-server
exec node dist/index.js
