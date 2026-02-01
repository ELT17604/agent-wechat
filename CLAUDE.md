# Claude Context for agent-wechat

## What This Project Is

WeChat automation via LLM-powered UI control. WeChat runs in a Docker container with an AI agent that observes screenshots/accessibility and performs actions.

## Architecture (Current)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Docker Container                              │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────────┐   │
│  │ agent-server │───▶│    Xvfb      │───▶│   WeChat App    │   │
│  │  (Node.js)   │    │  + fluxbox   │    │                 │   │
│  │  Port 6174   │    │  + a11y      │    │                 │   │
│  └──────────────┘    └──────────────┘    └─────────────────┘   │
│         │                                                        │
│         │  Tools: wechat-screenshot, wechat-a11y,               │
│         │         wechat-click, wechat-type, db-* commands      │
│         │                                                        │
│  ┌──────┴───────┐    ┌──────────────┐                           │
│  │   SQLite DB  │    │  LLM Agent   │  (AI SDK + Gemini)        │
│  │  (/data/)    │    │              │                           │
│  └──────────────┘    └──────────────┘                           │
└─────────▲────────────────────────────────────────────────────────┘
          │
          │ HTTP (tRPC-style)
          │
┌─────────┴────────────────────────────────────────────────────────┐
│                         CLI (Host)                                │
│  pnpm cli up/down/status/login/chats/send/...                    │
└──────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| LLM location | Inside container | Keeps state in sync with UI |
| LLM tools | Only `bash` + `readFile` | Security - whitelisted commands prevent prompt injection |
| Database | SQLite inside container | Simple, no external deps |
| CLI | HTTP client only | No Docker API access needed |
| Provider | Gemini via AI SDK | Flash model is fast/cheap |

## Packages

```
packages/
├── shared/           # Types + Zod schemas (Chat, Message, etc.)
├── agent-server/     # Runs INSIDE container - tRPC server + LLM agent
└── cli/              # Runs on HOST - HTTP client
```

## Security Model (Prompt Injection Prevention)

The LLM only has two tools:
1. `bash` - executes ONLY whitelisted commands:
   - `wechat-screenshot`, `wechat-a11y`, `wechat-click`, `wechat-type`, `wechat-key`, `wechat-scroll`
   - `db-list-chats`, `db-get-chat`, `db-upsert-chat`, etc.
2. `readFile` - reads files from `/tmp`, `/data`, `/home/wechat` only

WeChat content (messages, usernames) cannot escape to execute arbitrary commands.

## Tool Scripts (in container at /opt/tools/)

**UI Observation:**
- `wechat-screenshot` - returns path to PNG file
- `wechat-a11y --scope <chats|messages|full|desktop>` - returns JSON (desktop = all windows)

**UI Interaction:**
- `wechat-click <x> <y>` - click coordinates
- `wechat-type "<text>"` - type via clipboard (Unicode-safe)
- `wechat-key <combo>` - press keys (Return, ctrl+a, etc.)
- `wechat-scroll <up|down> [amount]`

**Database:**
- `db-list-chats`, `db-get-chat`, `db-upsert-chat`, etc.
- `db-list-messages`, `db-upsert-message`, etc.

## Gemini Image Handling

Gemini doesn't support images in tool results. We use `LanguageModelV1Middleware` to:
1. Extract images from tool results
2. Add them as user messages instead

See: `packages/agent-server/src/agent/middleware.ts`

## CLI Commands

```bash
pnpm cli up          # Start container
pnpm cli down        # Stop container
pnpm cli status      # Check server + login state
pnpm cli login       # Get QR code
pnpm cli chats       # List chats (triggers LLM if DB empty)
pnpm cli send <id> <msg>  # Send message
```

## Building

```bash
pnpm build                    # Build TypeScript
pnpm build:image:arm64        # Build Docker image (ARM)
pnpm build:image:amd64        # Build Docker image (Intel)
```

## Environment Variables

- `GOOGLE_GENERATIVE_AI_API_KEY` - Required for Gemini
- `AGENT_WECHAT_URL` - Override server URL (default: http://localhost:6174)

## Files Changed in Migration

The project was migrated from a host-side Docker control architecture to container-side agent.

**New packages:**
- `packages/shared/` - Types + schemas
- `packages/agent-server/` - tRPC server + LLM agent
- `packages/cli/` - Simple HTTP client

**Updated Docker:**
- `docker/Dockerfile` - Added Node.js, pnpm, tool scripts, agent-server
- `docker/entrypoint.sh` - Starts agent-server as main process
- `docker/tools/` - Bash wrappers for UI automation + DB commands

## Current Issues / TODOs

- [ ] `better-sqlite3` native module needs rebuild in container
- [ ] VNC on port 5900 for debugging
- [ ] No auth token implemented yet
- [ ] File sending not implemented

## How Agent Loops Work

Each API call (e.g., `chats.list`) may trigger an agent loop:

1. Check SQLite database first
2. If empty/stale, run LLM agent
3. Agent takes screenshots, reads a11y, saves to DB
4. Return results from DB

Agent uses `generateText` with `maxSteps: 30` for multi-turn tool use.
