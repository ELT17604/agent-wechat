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
│         │  Tools: wechat-screenshot, wechat-a11y-dump,          │
│         │         wechat-click, wechat-type, wechat-key         │
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
├── shared/           # Types (Chat, Message, LoginSubscriptionEvent, etc.)
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
```typescript
// Effects fire ONLY when state changes (reactive, not imperative)
export const effectWatchers: EffectWatcher[] = [
  // QR changed → emit to client
  ({ prev, next }) =>
    next.mainWindow.qrData !== prev.mainWindow.qrData
      ? [{ type: "emit", event: { type: "qr", qrData: next.mainWindow.qrData } }]
      : [],

  // Entered phone_confirm → emit once
  ({ prev, next }) =>
    next.mainWindow.view === "login_phone_confirm" &&
    prev.mainWindow.view !== "login_phone_confirm"
      ? [{ type: "emit", event: { type: "phone_confirm" } }]
      : [],

  // Reached chat from login → emit success
  ({ prev, next }) =>
    next.mainWindow.view === "chat" && prev.mainWindow.view.startsWith("login")
      ? [{ type: "emit", event: { type: "login_success" } }]
      : [],
];
```

**Plans** (`src/plans/login.ts`):
```typescript
export const loginPlan: Plan<LoginParams> = {
  id: "login",
  // Goal checked AFTER action executes
  isGoalReached: ({ state }) =>
    state.mainWindow.view === "chat" && state.popup === null,
  selectAction: ({ state, params }) => {
    if (state.popup) return "dismiss_popup";
    switch (state.mainWindow.view) {
      case "login_qr": return "wait";
      case "login_account": return params.newAccount ? "click_switch_account" : "click_login";
      case "login_phone_confirm": return "wait";
      case "login_loading": return "wait";
      case "chat": return "maximize";  // Final action before goal reached
      default: return null;
    }
  },
};
```

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
- `wechat-screenshot` - returns base64 PNG
- `wechat-a11y-dump` - returns nested JSON a11y tree

**UI Interaction:**
- `wechat-click <x> <y>` - click coordinates
- `wechat-type "<text>"` - type via clipboard (Unicode-safe)
- `wechat-key <combo>` - press keys (Return, Escape, ctrl+a, etc.)
- `wechat-scroll <up|down> [amount]`

## CLI Commands

```bash
pnpm cli up              # Start container
pnpm cli down            # Stop container
pnpm cli status          # Check server + login state
pnpm cli auth login      # Subscribe to login flow (shows QR in terminal)
pnpm cli chats list      # List chats from DB (id, unread, group, name)
pnpm cli chats sync      # Sync chat list via selection (default: 20 chats)
pnpm cli send <id> <msg> # Send message to chat
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
| `sessions` | Multi-user sessions (display, VNC port, login state) |
| `chats` | Chat/conversation metadata (name, avatar hash, unread count) |
| `messages` | Message content and metadata |
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
| Login flow | Deterministic FSM | Fast, cheap, reliable - no LLM needed |
| State management | Redux-like (reduce → effects) | Pure reducers, reactive effects on state diff |
| Effects | Fire on state CHANGE only | Prevents duplicate emissions |
| Commands | Per-state (not global) | Each state defines available commands |
| Execution order | Action → Goal check | Allows final actions before completion |
| A11y tree | Parent refs added | Enables `findAncestor` for frame scoping |
| Click/type scoping | Use frame from metadata | Ensures actions target correct window |
| A11y selectors | CSS-like syntax | Familiar, composable |
| Context | Persisted to SQLite | Survives restarts |

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

## Chat Sync Algorithm

The `syncChatsPlan` uses selection-based navigation to sync chats reliably:

1. **Init**: Close any open chat, press `Home`, then `ctrl+Tab` to focus first item
2. **Loop** (no chat open - checking focused item):
   - If focused should skip (File Transfer, Official Accounts, etc.) → `ctrl+Tab`
   - If focused === lastSelected → done (looped back to start)
   - Otherwise → note unreadCount, press `space` to select
3. **Loop** (chat open - persist and move on):
   - Read chat name from header (unambiguous)
   - Detect group via `(n)` member count pattern
   - Extract avatar image hash from selected list item
   - Persist to DB with noted unreadCount
   - Emit `sync_progress` event
   - Click to close, `ctrl+Tab` to next

**Key features:**
- Uses AT-SPI states (`SELECTED`, `FOCUSED`) for reliable detection
- Plan-local state (`planState`) tracks progress without persisting to AppState
- Decoupled `ctrl+Tab` and `space` for skip handling
- Matching: image hash first, then exact name (if unique)

## Current Status

- [x] Deterministic FSM for login flow
- [x] Effect watchers for QR/phone_confirm/login_success
- [x] Context persistence to SQLite
- [x] Parent refs in a11y tree + findAncestor helper
- [x] Frame-scoped click/type actions
- [x] Per-state commands with shared base (window controls)
- [x] Post-login maximize via execution loop (action → goal check)
- [x] Chat list sync via selection-based FSM plan (`syncChatsPlan`)
- [x] Chat identity matching (image hash first, name fallback)
- [x] Split chat states: `chat` (no selection) vs `chat_open` (with SELECTED item)
- [x] AT-SPI states (SELECTED, FOCUSED) in a11y tree
- [x] Plan-local state for execution-scoped data
- [ ] Send message via FSM plan
- [ ] File sending
