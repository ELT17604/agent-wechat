# @agent-wechat/wechat

OpenClaw channel plugin for WeChat. Polls the agent-wechat REST API for inbound messages and dispatches replies through OpenClaw's agent runtime.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running (or a hosted agent-wechat instance)
- OpenClaw installed and configured

> **Note:** The agent-wechat container requires `SYS_PTRACE` and `seccomp=unconfined` (ptrace access to the WeChat desktop process). It cannot run in serverless or restricted container environments (AWS Fargate, Cloud Run, etc.) — use a VM or bare-metal Docker host.

## Setup

### 1. Start the agent-wechat container

**Option A: CLI** (quickest for local use)

```bash
npm install -g @agent-wechat/cli
wx up
```

**Option B: Docker Compose** (production / networked)

```yaml
services:
  agent-wechat:
    image: ghcr.io/thisnick/agent-wechat:latest
    container_name: agent-wechat
    security_opt:
      - seccomp=unconfined
    cap_add:
      - SYS_PTRACE
    ports:
      - "6174:6174"
      - "127.0.0.1:5900:5900"
    volumes:
      - agent-wechat-data:/data
      - agent-wechat-home:/home/wechat
      - ~/.config/agent-wechat/token:/data/auth-token:ro
    restart: unless-stopped

volumes:
  agent-wechat-data:
  agent-wechat-home:
```

Generate a token before starting:

```bash
mkdir -p ~/.config/agent-wechat
openssl rand -hex 32 > ~/.config/agent-wechat/token
chmod 600 ~/.config/agent-wechat/token
docker compose up -d
```

If running alongside OpenClaw on the same Docker network, set `serverUrl` to `http://agent-wechat:6174` in the channel config below.

**Option C: Hosted instance**

If someone has provisioned a hosted agent-wechat instance for you, you'll receive a server URL and auth token. Skip to step 2 — just provide the URL and token during channel setup.

### 2. Install the extension

```bash
openclaw plugins install @agent-wechat/wechat
```

### 3. Log in to WeChat

```bash
openclaw channels login --channel wechat
```

This displays a QR code in your terminal — scan it with WeChat on your phone. You only need to do this once (the session persists across container restarts).

If you installed the CLI, you can also use `wx auth login`.

### 4. Configure the channel

```bash
# Uses defaults (localhost:6174, token from ~/.config/agent-wechat/token)
openclaw channels add --channel wechat

# Override server URL and token
openclaw channels add --channel wechat --url <url> --token <token>
```

Or edit `~/.openclaw/openclaw.json` directly:

```json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "serverUrl": "http://localhost:6174"
    }
  }
}
```

For local setups, the token is automatically read from `~/.config/agent-wechat/token` (shared with the CLI and container), so you don't need to set it in the config. For hosted instances, add the `token` field with the token you were given.

### 5. Run the gateway

```bash
openclaw gateway run --verbose
```

The WeChat monitor starts polling the agent-wechat server for new messages. Make sure the agent-wechat container is running.

## Configuration Reference

All config lives under `channels.wechat` in OpenClaw's config file:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the WeChat channel |
| `serverUrl` | string | — | agent-wechat REST API URL |
| `token` | string | — | Auth token (required for hosted instances) |
| `dmPolicy` | `"open" \| "allowlist" \| "disabled"` | `"disabled"` | Who can DM the bot |
| `allowFrom` | string[] | `[]` | wxid allowlist for DMs (when policy is `allowlist`) |
| `groupPolicy` | `"open" \| "allowlist" \| "disabled"` | `"disabled"` | Group message policy |
| `groupAllowFrom` | string[] | `[]` | wxid allowlist for group senders |
| `groups` | object | `{}` | Per-group overrides (e.g. `{ "id@chatroom": { "requireMention": false } }`) |
| `pollIntervalMs` | integer | `1000` | Message polling interval |
| `authPollIntervalMs` | integer | `30000` | Auth status check interval |

## Development

### Build from source

```bash
git clone https://github.com/thisnick/agent-wechat.git
cd agent-wechat
pnpm install && pnpm build
```

### Link for local development

```bash
openclaw plugins install -l ./packages/openclaw-extension
```

This symlinks the extension so changes are picked up without reinstalling. Rebuild with `pnpm build` after making changes, then restart the gateway.

## Architecture

```
OpenClaw Gateway
  └── WeChat Monitor (polling loop)
        │
        │  GET /api/chats          (list chats with unreads)
        │  POST /api/chats/{id}/open  (open chat, clear unreads)
        │  GET /api/messages/{id}  (fetch new messages)
        │  GET /api/messages/{id}/media/{localId}  (download media)
        │  POST /api/messages/send (send reply)
        │
        ▼
  agent-wechat container (port 6174)
        │
        ▼
  WeChat Desktop (in Xvfb)
```

The monitor polls for chats with unread messages, fetches new messages, resolves routing/session via OpenClaw's runtime, and dispatches replies back through the agent-wechat API.
