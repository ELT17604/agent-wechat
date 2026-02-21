# @agent-wechat/wechat

OpenClaw channel plugin for WeChat. Polls the agent-wechat REST API for inbound messages and dispatches replies through OpenClaw's agent runtime.

## Prerequisites

- **agent-wechat container** running and reachable (provides the REST API on port 6174). Install [`@agent-wechat/cli`](https://www.npmjs.com/package/@agent-wechat/cli) and run `wx up`, or use Docker Compose — see the [CLI docs](https://github.com/thisnick/agent-wechat/tree/main/packages/cli#running-the-container) for setup options.
- **OpenClaw** installed and configured

> **Note:** The agent-wechat container requires `SYS_PTRACE` and `seccomp=unconfined` (ptrace access to the WeChat desktop process). It cannot run in serverless or restricted container environments — use a VM or bare-metal Docker host.

## Install

```bash
openclaw plugins install @agent-wechat/wechat
```

## Configure

Run the setup wizard:

```bash
openclaw channels setup wechat
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

## Run

```bash
openclaw gateway run --verbose
```

The WeChat monitor starts polling the agent-wechat server for new messages. Make sure the agent-wechat container is running (`wx up` / `wx status`).

## Configuration Reference

All config lives under `channels.wechat` in OpenClaw's config file:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the WeChat channel |
| `serverUrl` | string | — | agent-wechat REST API URL |
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
