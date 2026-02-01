FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ============================================
# System packages
# ============================================
RUN apt-get update && apt-get install -y \
    # Display
    xvfb fluxbox x11vnc \
    # Input automation
    xdotool scrot \
    # Accessibility
    at-spi2-core gir1.2-atspi-2.0 python3 python3-gi \
    # Fonts
    fonts-noto-cjk \
    # System
    dbus dbus-x11 ca-certificates curl \
    # WeChat dependencies
    libatomic1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnss3 libx11-6 \
    libxkbcommon0 libxkbcommon-x11-0 libxcb-icccm4 \
    libxcb-image0 libxcb-keysyms1 libxcb-render-util0 libxss1 \
    # New packages for agent-server
    xclip \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# Node.js 22 + pnpm + build tools (for native modules)
# ============================================
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs python3 make g++ \
    && npm install -g pnpm \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# X11 socket directory
# ============================================
RUN mkdir -p /tmp/.X11-unix && chown root:root /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# ============================================
# WeChat
# ============================================
COPY wechat.deb /tmp/wechat.deb
RUN dpkg -i /tmp/wechat.deb || (apt-get update && apt-get install -y -f) \
    && rm -rf /var/lib/apt/lists/* /tmp/wechat.deb

RUN useradd -m -s /bin/bash wechat

# ============================================
# Tool scripts (wechat-*, db-*, wechat-a11y-dump)
# ============================================
RUN mkdir -p /opt/tools
COPY tools/ /opt/tools/
RUN chmod +x /opt/tools/*

# ============================================
# Shared package (dependency of agent-server)
# ============================================
WORKDIR /opt/shared
COPY shared/dist ./dist
COPY shared/package.json ./
RUN pnpm install --prod

# ============================================
# Agent server
# ============================================
WORKDIR /opt/agent-server
COPY agent-server/dist ./dist
COPY agent-server/package.json ./
# Install and rebuild native modules
ENV PNPM_ENABLE_PRE_POST_SCRIPTS=true
RUN pnpm install --prod && \
    cd node_modules/better-sqlite3 && npm run build-release

# ============================================
# Data directory for SQLite
# ============================================
RUN mkdir -p /data && chown wechat:wechat /data
VOLUME /data

# ============================================
# Environment
# ============================================
ENV DISPLAY=:99
ENV PATH="/opt/tools:$PATH"
ENV AGENT_DB_PATH=/data/agent.db
ENV AGENT_PORT=6174

# ============================================
# Entrypoint
# ============================================
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 6174 5900

ENTRYPOINT ["/entrypoint.sh"]
