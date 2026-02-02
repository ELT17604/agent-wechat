# agent-wechat

WeChat automation via deterministic FSM. Runs WeChat in a Docker container with UI automation.

## Requirements

- Docker (via Colima on macOS, or Docker Desktop)
- Node.js >= 22
- pnpm

## Quick Start

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Build Docker image (choose your arch)
pnpm build:image:arm64   # Apple Silicon
pnpm build:image:amd64   # Intel

# Start container
pnpm cli up

# Connect VNC to see WeChat UI (optional)
# Open VNC viewer → localhost:5900

# Check status
pnpm cli status

# Login (shows QR code in terminal)
pnpm cli login

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
| `pnpm cli login` | Subscribe to login flow (shows QR) |

## Architecture

- **Container**: WeChat + Xvfb + agent-server (Node.js)
- **FSM Engine**: Deterministic state machine for UI automation
- **CLI**: HTTP/WebSocket client that talks to agent-server

See [CLAUDE.md](./CLAUDE.md) for technical details.

## Development

```bash
# Build all packages
pnpm build

# Start in dev mode (mounts local dist for hot reload)
pnpm dev

# In another terminal, watch for changes
pnpm build:watch

# Type check
pnpm typecheck
```

Dev mode exposes port 9229 for Node.js debugging.

## Ports

- `6174` - Agent server API
- `5900` - VNC (view WeChat UI)
