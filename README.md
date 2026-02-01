# agent-wechat

WeChat automation via LLM-powered UI control. Runs WeChat in a Docker container with an AI agent.

## Requirements

- Docker (via Colima on macOS, or Docker Desktop)
- Node.js >= 22
- pnpm
- `GOOGLE_GENERATIVE_AI_API_KEY` for Gemini

## Quick Start

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Build Docker image (choose your arch)
pnpm build:image:arm64   # Apple Silicon
pnpm build:image:amd64   # Intel

# Set Gemini API key
export GOOGLE_GENERATIVE_AI_API_KEY="your-key"

# Start container
pnpm cli up

# Connect VNC to see WeChat UI (optional)
# Open VNC viewer → localhost:5900

# Check status
pnpm cli status

# Login (shows QR code)
pnpm cli login

# List chats
pnpm cli chats

# Send a message
pnpm cli send <chatId> "Hello!"

# Stop container
pnpm cli down
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `pnpm cli up` | Start the WeChat container |
| `pnpm cli down` | Stop and remove container |
| `pnpm cli logs` | Stream container logs |
| `pnpm cli status` | Show server and login status |
| `pnpm cli login` | Get QR code for login |
| `pnpm cli chats [limit]` | List chats |
| `pnpm cli find <name>` | Find chat by name |
| `pnpm cli messages <chatId>` | Get messages |
| `pnpm cli send <chatId> <msg>` | Send a message |
| `pnpm cli sync <chatId>` | Sync messages from UI |

## Architecture

- **Container**: WeChat + Xvfb + agent-server (Node.js)
- **Agent**: LLM (Gemini) with UI automation tools
- **CLI**: HTTP client that talks to agent-server

See [CLAUDE.md](./CLAUDE.md) for technical details.

## Development

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter @anthropic/agent-wechat-server build

# Type check
pnpm typecheck
```

## Ports

- `6174` - Agent server API
- `5900` - VNC (view WeChat UI)
