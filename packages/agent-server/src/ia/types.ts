import type { z } from "zod";
import type Database from "better-sqlite3";
import type { Session } from "@thisnick/agent-wechat-shared";

// Re-export Session from shared
export type { Session };

// ============================================
// A11y Tree Types (from wechat-a11y-dump)
// ============================================

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface A11yNode {
  role: string;
  name: string;
  bounds?: Bounds;
  children?: A11yNode[];
  parent?: A11yNode;
}

// ============================================
// CSS-like Selector (string)
// ============================================

// Examples:
//   'push-button[name="OK"]'
//   'frame[name="WeChat"] push-button[name="OK"]'  // descendant
//   'list[name="Chats"] > list-item:nth-child(2)'  // child + index
//   'push-button[name=/OK|Confirm/i]'              // regex
export type Selector = string;

// ============================================
// Actions
// ============================================

export interface SubscriptionEvent {
  type: string;
  [key: string]: unknown;
}

export type Action =
  | { type: "click"; selector: Selector }
  | { type: "type"; text: string; selector?: Selector }
  | { type: "key"; combo: string }
  | {
      type: "scroll";
      direction: "up" | "down";
      x?: number;
      y?: number;
      amount?: number;
    }
  | { type: "wait"; ms: number }
  | { type: "emit"; event: SubscriptionEvent }
  | { type: "sequence"; actions: Action[] };

// ============================================
// Action Parameters (typed globally)
// ============================================

export interface ActionParams {
  // Chat
  chatId?: string;
  chatName?: string;
  index?: number;

  // Message
  message?: string;

  // Search
  query?: string;

  // Login
  newAccount?: boolean;
}

// ============================================
// Multi-Window State Model
// ============================================

export type MainWindowView =
  | "login_qr"
  | "login_account"
  | "login_phone_confirm"
  | "login_loading"
  | "chat";

export interface SearchResult {
  name: string;
  bounds?: Bounds;
}

export interface MainWindowState {
  view: MainWindowView;

  // Login-specific
  qrData?: string;
  qrBinaryData?: number[];
  accountName?: string;

  // Chat-specific (when view === 'chat')
  selectedChatId?: string;
  searchQuery?: string;
  searchResults?: SearchResult[];

  // Window control bounds (captured from frame's toolbar)
  closeButtonBounds?: Bounds;
  minimizeButtonBounds?: Bounds;
  maximizeButtonBounds?: Bounds;
}

export interface PopupState {
  type: "error" | "confirm" | "info";
  message?: string;
}

export interface AppState {
  mainWindow: MainWindowState;
  popup: PopupState | null;
}

// ============================================
// State Definition
// ============================================

export interface IdentifyArgs {
  a11y: A11yNode;
  screenshot: string; // base64 PNG
}

/**
 * Result from identify function.
 * Can include metadata (e.g., matched frame) for use in reduce.
 */
export interface IdentifyResult<TMetadata = unknown> {
  identified: boolean;
  metadata?: TMetadata;
}

/**
 * Metadata containing a reference to the matched frame node.
 * Used by states that need to scope queries to a specific window.
 */
export interface FrameIdentifyMetadata {
  frame: A11yNode;
}

export interface ReduceArgs<TMetadata = unknown> {
  prev: AppState;
  action: Action | null;
  a11y: A11yNode;
  screenshot: Buffer;
  db: Database.Database;
  metadata?: TMetadata;
}

// Action template: can be a static action or a function that takes params
export type ActionTemplate = Action | ((params: ActionParams) => Action);

/**
 * IAState defines a UI state in the FSM.
 *
 * @template TMetadata - Type of metadata returned by identify and passed to reduce
 */
export interface IAState<TMetadata = unknown> {
  fsm: "mainWindow" | "popup";
  id: string;
  identify: (args: IdentifyArgs) => IdentifyResult<TMetadata>;
  reduce: (args: ReduceArgs<TMetadata>) => AppState;
  commands?: Record<string, ActionTemplate>;
}

// ============================================
// Effects (reactive side effects)
// ============================================

export type Effect =
  | { type: "emit"; event: SubscriptionEvent }
  | { type: "dbWrite"; table: string; data: unknown };

export interface EffectWatcherArgs {
  prev: AppState;
  next: AppState;
}

export type EffectWatcher = (args: EffectWatcherArgs) => Effect[];


// ============================================
// Context
// ============================================

export interface Context {
  sessionId: string;
  session: Session;
  db: Database.Database;
  state: AppState;
  save(): Promise<void>;
  load(): Promise<void>;
}

// ============================================
// Plan
// ============================================

export interface PlanArgs<TParams extends ActionParams = ActionParams> {
  state: AppState;
  params: TParams;
  db: Database.Database;
}

export interface Plan<TParams extends ActionParams = ActionParams> {
  id: string;
  description: string;
  params: z.ZodSchema<TParams>;
  isGoalReached: (args: PlanArgs<TParams>) => boolean;
  selectAction: (args: PlanArgs<TParams>) => string | null;
}

// ============================================
// Execution
// ============================================

export type ExecutionStatus = "running" | "succeeded" | "failed" | "aborted";

export interface Execution<TParams = unknown> {
  id: string;
  plan: Plan<TParams & ActionParams>;
  params: TParams;
  context: Context;
  status: ExecutionStatus;
  stepCount: number;
  lastAction?: Action;
  error?: string;
  abortSignal: AbortSignal;
  emit: (event: SubscriptionEvent) => void;
}

// ============================================
// Chat & Message (for DB)
// ============================================

export interface Chat {
  id: string;
  name: string;
  avatarHash?: string;
  unreadCount: number;
  lastMessagePreview?: string;
  lastMessageTime?: string;
  lastMessageSender?: string;
  pinned: boolean;
  muted: boolean;
  bounds?: Bounds;
}

export interface Message {
  id: string;
  chatId?: string;
  content: string;
  senderName?: string;
  timestamp?: string;
  outgoing: boolean;
  type: string;
  metadata?: Record<string, unknown>;
  bounds?: Bounds;
}

// ============================================
// Default State
// ============================================

export function createDefaultAppState(): AppState {
  return {
    mainWindow: { view: "login_qr" },
    popup: null,
  };
}
