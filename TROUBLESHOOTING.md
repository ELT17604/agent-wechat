# Troubleshooting

## Login Plan Stalls After QR Scan (view=Chat, loggedInUser=null, chats=[])

### Symptoms
- `/api/status/auth` shows `status: "logged_in"` but `loggedInUser: null`
- `/api/chats` returns `[]`
- VNC shows the Chat view but messages don't appear
- Agent-server logs show `view=Chat` repeated every ~30s with no progress

### Root Cause
`POST /api/auth/login` (REST endpoint) only captures a screenshot and decodes a QR code.
It does **not** start the FSM login execution loop.

The WebSocket endpoint (`ws://.../api/auth/login/ws`) or `wx auth login` CLI command
spawns the full `run_execution_loop()` that drives the login FSM through all phases:

```
Initializing → Authenticating → Maximizing → DetectingUser → ExtractingKeys → Done
```

### Fix
Use the CLI or WebSocket to login:

```bash
# CLI method (recommended)
export AGENT_WECHAT_URL=http://localhost:6174
export AGENT_WECHAT_TOKEN=$(cat ~/.config/agent-wechat/token)
wx auth login

# Output:
# Initiating login...
# Status: Navigating login flow...
# Status: Getting your WeChat messages...
# Login successful!
# User ID: wxid_xxxxxxxxxxxx
```

Or trigger from the OpenClaw plugin:
```
Tell your AI agent "Log in to WeChat" and it will use the WebSocket flow.
```

### Verification
```bash
curl -H "Authorization: Bearer $AGENT_WECHAT_TOKEN" \
  http://localhost:6174/api/status/auth
# Should show loggedInUser with your wxid

curl -H "Authorization: Bearer $AGENT_WECHAT_TOKEN" \
  http://localhost:6174/api/chats?limit=5
# Should show chat list with recent messages
```

## Channel Not Appearing in OpenClaw

### Symptoms
- Plugin installed (`openclaw plugins install @agent-wechat/wechat`) but not in `channels list`
- Gateway logs: "discovered non-bundled plugins may auto-load: openclaw-weixin, qqbot" (no wechat)

### Fix
Ensure the plugin is registered in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "wechat": { "enabled": true }
    }
  }
}
```

Then restart: `openclaw gateway restart`

## WeChat Window Appears Tiny (3×3 pixels)

### Symptoms
- `xdotool getwindowgeometry` shows `Geometry: 3x3`
- FSM may fail to identify UI elements at small window sizes

### Fix
```bash
docker exec agent-wechat su -s /bin/sh -c \
  "DISPLAY=:99 xdotool search --name WeChat | \
   xargs -I{} xdotool windowsize {} 1280 800 windowmove {} 0 0" wechat
```

The agent-server login plan automatically sends a maximize action when
view reaches Chat, but ensuring the window is large enough before login
can prevent timing issues.

## Docker Registry Pull Fails in China (GFW)

### Symptoms
- `docker pull ghcr.io/thisnick/agent-wechat:latest` hangs at "Pulling fs layer"
- `connection reset by peer` on IPv6 connections
- `TLS handshake timeout` on IPv4

### Fix
Use `crane` with an HTTP proxy:

```bash
# Install crane
curl -fsSL https://github.com/google/go-containerregistry/releases/download/v0.21.7/go-containerregistry_Linux_x86_64.tar.gz | tar xz crane

# Pull through proxy
export HTTP_PROXY=http://your-proxy:port
export HTTPS_PROXY=http://your-proxy:port
crane pull ghcr.io/thisnick/agent-wechat:latest /tmp/agent-wechat.tar

# Load into Docker
docker load -i /tmp/agent-wechat.tar
```

See also: [Hosting guide](https://thisnick.github.io/agent-wechat/guides/hosting/)
