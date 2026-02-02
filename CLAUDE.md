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
| **Commands** | `src/ia/actions.ts` | UI operations (click, type, scroll, wait) |
| **Plan** | `src/plans/*.ts` | Goal + action selection logic |
| **Execution** | `src/execution/index.ts` | Main loop that runs the FSM |
| **Context** | `src/context/index.ts` | Persists AppState to SQLite |

### Execution Loop

```
┌──────────────────────────────────────────────────────────────┐
│                    Execution Loop                             │
│                                                               │
│  1. OBSERVE    → a11y tree + screenshot                       │
│  2. IDENTIFY   → find IAState where identify(obs) = true      │
│  3. REDUCE     → iaState.reduce(prev, obs) → next AppState    │
│  4. EFFECTS    → watchers(prev, next) → Effect[] (on change)  │
│  5. PERSIST    → save AppState to SQLite                      │
│  6. GOAL?      → plan.isGoalReached(state) → done?            │
│  7. SELECT     → plan.selectAction(state) → action key        │
│  8. EXECUTE    → run command (click, type, wait, etc.)        │
│  9. LOOP       → back to step 1                               │
└──────────────────────────────────────────────────────────────┘
```

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
  | { type: "click"; selector: string }
  | { type: "type"; text: string }
  | { type: "key"; combo: string }
  | { type: "scroll"; direction: "up" | "down"; x: number; y: number }
  | { type: "wait"; ms: number }
  | { type: "sequence"; actions: Action[] };

// IAState defines a view state
interface IAState {
  fsm: "mainWindow" | "popup";
  id: string;
  identify: (args: { a11y, screenshot }) => boolean;
  reduce: (args: { prev, a11y, screenshot, db }) => AppState;
  commands?: Record<string, Action | ((params) => Action)>;
}
```

**States** (`src/ia/states/`):
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
  isGoalReached: ({ state }) => state.mainWindow.view === "chat",
  selectAction: ({ state, params }) => {
    if (state.popup) return "dismiss_popup";
    switch (state.mainWindow.view) {
      case "login_qr": return "wait";
      case "login_account": return params.newAccount ? "click_switch_account" : "click_login";
      case "login_phone_confirm": return "wait";
      case "login_loading": return "wait";
      default: return null;
    }
  },
};
```

### CSS-like Selectors

The a11y tree uses CSS-like selectors (`src/ia/selectors.ts`):

```typescript
// Examples:
querySelector(a11y, 'push-button[name="Log In"]')
querySelector(a11y, 'list[name="Chats"] > list-item:nth-child(1)')
querySelector(a11y, 'push-button[name=/OK|Confirm|确定/i]')  // regex
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
pnpm cli up          # Start container
pnpm cli down        # Stop container
pnpm cli status      # Check server + login state
pnpm cli login       # Subscribe to login flow (shows QR in terminal)
pnpm cli chats       # List chats
pnpm cli send <name> <msg>  # Send message
```

## Building

```bash
pnpm build                    # Build TypeScript
pnpm build:image:arm64        # Build Docker image (ARM)
pnpm build:image:amd64        # Build Docker image (Intel)
```

## Environment Variables

- `AGENT_WECHAT_URL` - Override server URL (default: http://localhost:6174)

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Login flow | Deterministic FSM | Fast, cheap, reliable - no LLM needed |
| State management | Redux-like (reduce → effects) | Pure reducers, reactive effects on state diff |
| Effects | Fire on state CHANGE only | Prevents duplicate emissions |
| Commands | UI ops only (no emissions) | Emissions handled by effects |
| A11y selectors | CSS-like syntax | Familiar, composable |
| Context | Persisted to SQLite | Survives restarts |

## Adding New Features

**To add a new login state:**
1. Add state to `src/ia/states/login.ts` with `identify`, `reduce`, `commands`
2. Add to `loginStates` array export
3. Update `src/plans/login.ts` if action selection needed

**To add a new effect:**
1. Add watcher function to `src/effects/watchers.ts`
2. Watcher receives `{ prev, next }` AppState, returns `Effect[]`

**To add a new plan:**
1. Create `src/plans/myplan.ts` with `isGoalReached` and `selectAction`
2. Export from `src/plans/index.ts`
3. Call via `createExecution(myPlan, params, context, options)`

## Current Status

- [x] Deterministic FSM for login flow
- [x] Effect watchers for QR/phone_confirm/login_success
- [x] Context persistence to SQLite
- [ ] Chat listing via FSM plan
- [ ] Send message via FSM plan
- [ ] File sending
