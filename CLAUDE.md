# Claude Context for agent-wechat

## What This Project Is

WeChat automation via UI control. WeChat runs in a Docker container with automation that observes accessibility trees/screenshots and performs actions.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Docker Container                              │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────────┐   │
│  │ agent-server │───▶│    Xvfb      │───▶│   WeChat App    │   │
│  │  (Node.js)   │    │  + fluxbox   │    │                 │   │
│  │  Port 6174   │    │  + AT-SPI    │    │                 │   │
│  └──────────────┘    └──────────────┘    └─────────────────┘   │
│         │                                                        │
│         │  Tools: screenshot, a11y-dump, click, type, key        │
│         │                                                        │
│         │                                                        │
│  ┌──────┴───────┐    ┌──────────────┐                           │
│  │   SQLite DB  │    │  FSM Engine  │  (Deterministic)          │
│  │  (/data/)    │    │              │                           │
│  └──────────────┘    └──────────────┘                           │
└─────────▲────────────────────────────────────────────────────────┘
          │
          │ HTTP (tRPC) + WebSocket (subscriptions)
          │
┌─────────┴────────────────────────────────────────────────────────┐
│                         CLI (Host)                                │
│  pnpm cli up/down/status/login/chats/send/...                    │
└──────────────────────────────────────────────────────────────────┘
```

## Packages

```
packages/
├── shared/           # Types (Chat, LoginSubscriptionEvent, etc.)
├── agent-server/     # Runs INSIDE container - tRPC server + FSM engine
└── cli/              # Runs on HOST - HTTP client
```

## FSM Architecture (Login Flow)

The login flow uses a **deterministic FSM** instead of an LLM. This is faster, cheaper, and more reliable.

### Core Concepts

| Concept | Location | Purpose |
|---------|----------|---------|
| **IAState** | `src/ia/states/*.ts` | View state: identify from a11y, reduce to AppState, available commands |
| **Effects** | `src/effects/watchers.ts` | Reactive side effects that fire on state change |
| **Commands** | `src/ia/states/*.ts` | Per-state UI operations (click, type, scroll, wait) |
| **Base Commands** | `src/ia/states/base.ts` | Shared commands (maximize, minimize, close) |
| **Plan** | `src/plans/*.ts` | Goal + action selection logic |
| **Execution** | `src/execution/index.ts` | Main loop that runs the FSM |
| **Context** | `src/context/index.ts` | Persists AppState to SQLite |

### Execution Loop

```
┌──────────────────────────────────────────────────────────────┐
│                    Execution Loop                             │
│                                                               │
│  1. OBSERVE    → a11y tree + screenshot (with parent refs)    │
│  2. IDENTIFY   → find IAState, get metadata (e.g., frame)     │
│  3. REDUCE     → iaState.reduce(prev, obs, metadata) → state  │
│  4. EFFECTS    → watchers(prev, next) → Effect[] (on change)  │
│  5. PERSIST    → save AppState to SQLite                      │
│  6. SELECT     → plan.selectAction(state) → action key        │
│  7. EXECUTE    → run command (scoped to frame if available)   │
│  8. GOAL?      → plan.isGoalReached(state) → done?            │
│  9. LOOP       → back to step 1                               │
└──────────────────────────────────────────────────────────────┘
```

Note: Goal is checked AFTER action executes, so plans can run a final action before completing.

### Key Files

**Types** (`src/ia/types.ts`):
```typescript
// App state (persisted)
interface AppState {
  mainWindow: MainWindowState;  // view, qrData, selectedChatId, etc.
  popup: PopupState | null;
}

// Actions are UI operations
type Action =
  | { type: "click"; selector: string }      // Click by selector
  | { type: "click"; x: number; y: number }  // Click by coordinates
  | { type: "type"; text: string }
  | { type: "key"; combo: string }
  | { type: "scroll"; direction: "up" | "down"; x?: number; y?: number }
  | { type: "wait"; ms: number }
  | { type: "emit"; event: SubscriptionEvent }  // Emit event to client
  | { type: "sequence"; actions: Action[] };

// Identify returns metadata (e.g., matched frame for scoped queries)
interface IdentifyResult<TMetadata> {
  identified: boolean;
  metadata?: TMetadata;
}

// IAState defines a view state (generic over metadata type)
interface IAState<TMetadata = unknown> {
  fsm: "mainWindow" | "popup";
  id: string;
  identify: (args: { a11y, screenshot }) => IdentifyResult<TMetadata>;
  reduce: (args: { prev, a11y, screenshot, db, metadata }) => AppState;
  commands?: Record<string, Action | ((params) => Action)>;
}
```

**States** (`src/ia/states/`):
- `base.ts` - Shared commands: `windowControlCommands` (maximize, minimize, close, sticky)
- `login.ts` - Login states: `login_qr`, `login_account`, `login_phone_confirm`, `login_loading`
- `chat.ts` - Main chat view with chat list and messages
- `popup.ts` - Error/confirm/info popups

**Effects** (`src/effects/watchers.ts`):

Currently empty — all login emissions (QR, phone_confirm, login_success, status) are handled directly by the login plan via `planState` to ensure proper sequencing.

**Plans** (`src/plans/login.ts`):

Login plan phases: `authenticating → maximized → detecting_user → setup → done`

```
authenticating   Wait for QR scan, phone confirm, loading
     ↓           (transitions when view reaches "chat")
maximized        Send maximize command
     ↓
detecting_user   Find WeChat PID, resolve account directory
     ↓           If stored credentials are valid → skip to done
setup            Post-login setup (~20s), store credentials
     ↓
done             Emit login_success, goal check passes
```

The plan handles all emissions directly via `planState` (QR changes, phone_confirm, status messages, login_success) rather than using effect watchers.

**Plans** (`src/plans/chat-open.ts`):

Chat open plan: `pending → done` (single FSM step)

```
pending    Observe IA state, find click target from a11y tree
   ↓       Calls openChat() with coordinates + force flag
done       Result stored in planState.result, goal check passes
```

Key behaviors:
- **`chat_open` IA** (a chat is already selected): Uses Frida current-selection detection to skip if target is already open
- **`chat` IA** (no chat selected): Passes `--force` to bypass current-selection check (memory detection unreliable after deselect)
- Click coordinates from a11y tree passed via `--click-xy` to `chat-select.py`

**Async selectAction:** `Plan.selectAction` returns `Promise<SelectedAction | null>`, allowing plans to `await` tool calls (e.g., `openChat()`) without blocking the event loop. The execution loop `await`s each `selectAction` call.

**Plans** (`src/plans/send-message.ts`):

Send message plan: `opening → focusing → inputting → confirming → done`

```
opening      Open target chat via openChat()
   ↓
focusing     Find EDITABLE text sibling of Send(S) button, click to focus
   ↓
inputting    Text: Ctrl+A + paste + Enter; Image: paste-image + Enter
   ↓
confirming   Verify Send(S) DISABLED (message sent), retry up to 5x
   ↓
done         Goal reached
```

Key behaviors:
- Reuses `openChat()` from chat-select.ts in opening phase (same as chat-open plan)
- Finds edit component by structure: sibling of `push-button[name="Send(S)"]` with EDITABLE state
- A11y tree outputs DISABLED state for interactive elements (push-button, text, etc.) when ENABLED is absent
- Ctrl+A before paste ensures any existing text is replaced
- Image sending: CLI reads file → base64 via tRPC → server writes temp file → `paste-image` tool copies to clipboard via `xclip -t <mime>` → Ctrl+V paste → Enter to confirm

### CSS-like Selectors

The a11y tree uses CSS-like selectors (`src/ia/selectors.ts`):

```typescript
// Query descendants
querySelector(a11y, 'push-button[name="Log In"]')
querySelector(a11y, 'list[name="Chats"] > list-item:nth-child(1)')
querySelector(a11y, 'push-button[name=/OK|Confirm|确定/i]')  // regex

// Traverse up (a11y nodes have parent refs)
findAncestor(button, 'frame')  // Find containing frame
findAncestor(button, (n) => n.role === 'frame' && n.name === 'WeChat')
```

## Tool Scripts (in container at /opt/tools/)

**UI Observation:**
- `screenshot` - returns base64 PNG
- `a11y-dump` - returns nested JSON a11y tree

**UI Interaction:**
- `click <x> <y>` - click coordinates
- `input "<text>"` - type via clipboard paste (Unicode-safe)
- `paste-image <file> [mime]` - paste image via clipboard (xclip -t)
- `key <combo>` - press keys (Return, Escape, ctrl+a, etc.)
- `scroll <up|down> [amount]`

## CLI Commands

```bash
pnpm cli up              # Start container
pnpm cli down            # Stop container
pnpm cli status          # Check server + login state
pnpm cli auth login      # Login flow
pnpm cli chats list      # List chats
pnpm cli chats open <id> # Open a chat in the UI
pnpm cli find <name>     # Find chat by name
pnpm cli messages send <id> --text "msg"    # Send text message
pnpm cli messages send <id> --image f.png  # Send image
```

## Building

```bash
pnpm build                    # Build TypeScript
pnpm build:image:arm64        # Build Docker image (ARM)
pnpm build:image:amd64        # Build Docker image (Intel)
```

## Environment Variables

- `AGENT_WECHAT_URL` - Override server URL (default: http://localhost:6174)
- `AGENT_DB_PATH` - Override SQLite DB path (default: /data/agent.db)

## Database

### Overview

- **Technology**: SQLite + Drizzle ORM
- **Location**: `/data/agent.db` in container (configurable via `AGENT_DB_PATH`)
- **Schema**: `packages/agent-server/src/db/schema.ts`
- **Queries**: `packages/agent-server/src/db/queries.ts`
- **Migrations**: `packages/agent-server/drizzle/`

### Tables

| Table | Purpose |
|-------|---------|
| `sessions` | Multi-user sessions (display, VNC port, login state, `loggedInUser`) |
| `wechat_keys` | Credentials per (session, account, db_name) |
| `sync_state` | Key-value store for sync progress |
| `context` | FSM AppState persistence (JSON blob) |

### Initialization (Dual Approach)

On startup, `initDb()` in `src/db/index.ts` does:

1. **Legacy bootstrap**: `CREATE TABLE IF NOT EXISTS` for all tables
   - Frozen at v1 baseline schema
   - Ensures tables exist for fresh installs
2. **Drizzle migrations**: Runs any pending migrations from `drizzle/`
   - Handles schema changes (new columns, indexes, etc.)
   - If DB has tables but no migration history, baseline is auto-recorded

### Making Schema Changes

1. **Edit schema**: Update `src/db/schema.ts` with new columns/tables
2. **Generate migration**:
   ```bash
   cd packages/agent-server && npx drizzle-kit generate --config drizzle.config.ts
   ```
3. **Test**: Migration runs automatically on next server start

### Development Tips

- **Fresh start**: Delete DB file and restart - tables recreate from bootstrap + migrations
- **Schema mismatch errors**: Usually means you need to generate/run a migration
- **Type `DatabaseInstance`**: Drizzle wrapper, used in queries and effects (not raw `better-sqlite3`)
- **Don't edit legacy bootstrap**: It's frozen; use migrations for all changes

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Chat data | Direct WeChat DB reads | Fast, reliable — no RPA scraping needed |
| Login flow | Deterministic FSM | Fast, cheap, reliable - no LLM needed |
| State management | Redux-like (reduce → effects) | Pure reducers, reactive effects on state diff |
| Commands | Per-state (not global) | Each state defines available commands |
| Execution order | Action → Goal check | Allows final actions before completion |
| A11y tree | Parent refs added | Enables `findAncestor` for frame scoping |
| A11y selectors | CSS-like syntax | Familiar, composable |
| Context | Persisted to SQLite | Survives restarts |
| selectAction | Async (returns Promise) | Plans can await tool calls without blocking |

## Adding New Features

**To add a new state:**
1. Add state to `src/ia/states/*.ts` with `identify`, `reduce`, `commands`
2. Use `findAncestor` in identify to get frame metadata
3. Spread `...windowControlCommands` for common window controls
4. Add to the states array export
5. Update plans if action selection needed

Example state pattern:
```typescript
export const myState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "my_state",
  identify: ({ a11y }) => {
    const element = querySelector(a11y, 'some-selector');
    if (!element) return { identified: false };
    const frame = findAncestor(element, "frame");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },
  reduce: ({ prev, metadata }) => {
    const windowBounds = extractWindowControlBounds(metadata?.frame);
    return { ...prev, mainWindow: { view: "my_state", ...windowBounds } };
  },
  commands: {
    my_action: { type: "click", selector: 'button[name="Do Thing"]' },
    ...windowControlCommands,
  },
};
```

**To add a new effect:**
1. Add watcher function to `src/effects/watchers.ts`
2. Watcher receives `{ prev, next }` AppState, returns `Effect[]`

**To add a new plan:**
1. Create `src/plans/myplan.ts` with `isGoalReached` and `selectAction`
2. Export from `src/plans/index.ts`
3. Call via `createExecution(myPlan, params, context, options)`
4. Remember: action executes BEFORE goal check (can have final action)

## WeChat Data Access

Chat data is read directly from WeChat's local databases.

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/wechat-db.ts` | `queryWechatDb()`, `findAccountDir()`, `findWechatPid()` |
| `src/lib/wechat-keys.ts` | `extractKeys()`, `storeKeys()`, `needsKeyExtraction()`, `verifyKey()` |
| `src/lib/wechat-chats.ts` | `listChatsFromWechatDb()`, `getChatByUsername()`, `findChatsByName()` |

### Databases Queried

- `session.db` → `SessionTable` — active chats, sort order, unread counts, last message preview
- `contact.db` → `contact` — display names, remarks, aliases, avatars

### Gotchas

- `pgrep -f /usr/bin/wechat` returns multiple PIDs (wrapper + real process) — pick the one with most open fds
- Stored `wechatPid` goes stale after container rebuild — always fall back to `findWechatPid()`
- Extract-keys script exits non-zero if any key not found — catch error, read JSON output file anyway (partial success)

## Current Status

- [x] Deterministic FSM for login flow
- [x] Login plan with post-login setup (detect user → setup → done)
- [x] Direct WeChat DB reads (session.db, contact.db)
- [x] Smart credential management (verify existing, only re-extract when needed)
- [x] Context persistence to SQLite
- [x] Parent refs in a11y tree + findAncestor helper
- [x] Frame-scoped click/type actions
- [x] Per-state commands with shared base (window controls)
- [x] Plan-local state for execution-scoped data
- [x] Chat open via FSM plan (with current-selection detection)
- [x] Async selectAction for non-blocking tool calls in plans
- [x] Send message via FSM plan (text + image)
- [ ] Message history from WeChat DBs (message_0.db)
- [ ] File sending
