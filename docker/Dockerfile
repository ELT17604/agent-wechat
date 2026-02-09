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
    # Notifications
    dunst libnotify-bin \
    # Fonts
    fonts-noto-cjk \
    # System
    dbus dbus-x11 ca-certificates curl \
    # WeChat dependencies (basic)
    libatomic1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnss3 libx11-6 \
    libxkbcommon0 libxkbcommon-x11-0 libxcb-icccm4 \
    libxcb-image0 libxcb-keysyms1 libxcb-render-util0 libxss1 \
    # Audio - needed for message notifications
    pulseaudio alsa-base alsa-utils \
    gstreamer1.0-pulseaudio gstreamer1.0-alsa \
    # Media conversion (WXGF→JPEG/GIF, SILK→MP3)
    ffmpeg \
    # New packages for agent-server
    xclip \
    sqlite3 \
    # Build dependencies
    libssl-dev \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# Python packages
# ============================================
RUN pip3 install frida-tools silk-python

# ============================================
# Node.js 22 + pnpm + build tools (for native modules)
# ============================================
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs python3 make g++ \
    && npm install -g pnpm node-gyp \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# SQLCipher 4
# ============================================
RUN cd /tmp \
    && curl -L https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v4.6.1.tar.gz | tar xz \
    && cd sqlcipher-4.6.1 \
    && ./configure --enable-tempstore=yes CFLAGS="-DSQLITE_HAS_CODEC -DSQLCIPHER_CRYPTO_OPENSSL" LDFLAGS="-lcrypto" \
    && make -j$(nproc) \
    && cp sqlcipher /usr/local/bin/sqlcipher \
    && cd / && rm -rf /tmp/sqlcipher-4.6.1

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
# Tool scripts (screenshot, click, type, key, scroll, a11y-dump, etc.)
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
COPY agent-server/drizzle ./drizzle
COPY agent-server/package.json ./
# Install dependencies (skip native module builds initially)
RUN pnpm install --prod --ignore-scripts

# Rebuild native modules with global node-gyp (fixes Node.js v22 compatibility)
ENV npm_config_node_gyp=/usr/lib/node_modules/node-gyp/bin/node-gyp.js
RUN cd node_modules/better-sqlite3 && node-gyp rebuild --release
RUN cd node_modules/usocket && node-gyp rebuild --release || true

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
