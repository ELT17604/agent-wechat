import type { z } from "zod";
import type { DatabaseInstance } from "../db/index.js";
import type { Session } from "@thisnick/agent-wechat-shared";

// Re-export Session from shared
export type { Session };

// ============================================
// A11y Tree Types (from a11y-dump)
// ============================================

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface A11yWindowInfo {
  pid: number;
  id?: number;
  attributes?: Record<string, string>;
}

export interface A11yNode {
  role: string;
  name: string;
  bounds?: Bounds;
  children?: A11yNode[];
  parent?: A11yNode;
  window?: A11yWindowInfo; // Present on frame nodes
  states?: string[]; // AT-SPI states: FOCUSED, SELECTED, etc.
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
  | { type: "click"; selector: Selector; x?: never; y?: never }
  | { type: "click"; x: number; y: number; selector?: never }
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
  | "chat"
  | "chat_open";

export interface SearchResult {
  name: string;
  bounds?: Bounds;
}

export interface MainWindowState {
  view: MainWindowView;
  isLoggedIn: boolean;

  // Login-specific
  qrData?: string;
  qrBinaryData?: number[];
  accountName?: string;

  // Chat-specific (when view === 'chat' or 'chat_open')
  selectedChatId?: string;
  searchQuery?: string;
  searchResults?: SearchResult[];

  // Chat open specific (when view === 'chat_open')
  openedChatName?: string;
  openedChatIsGroup?: boolean;
  selectedChatBounds?: Bounds;

  // Window control bounds (captured from frame's toolbar)
  closeButtonBounds?: Bounds;
  minimizeButtonBounds?: Bounds;
  maximizeButtonBounds?: Bounds;
}

export interface PopupState {
  type: "error" | "confirm" | "info";
  message?: string;
}

/**
 * Contact card state - separate FSM for user profile cards.
 *
 * Separate from popup because:
 * 1. No OK/Confirm button - PopupActions.DISMISS doesn't work
 * 2. Has its own action vocabulary (Messages, Voice Call, Video Call, More, Escape)
 * 3. Semantically different from error/confirm dialogs
 */
export interface ContactCardState {
  wechatId?: string;
  contactName?: string;
}

export interface AppState {
  mainWindow: MainWindowState;
  popup: PopupState | null;
  contactCard: ContactCardState | null;
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
  db: DatabaseInstance;
  metadata?: TMetadata;
}

/**
 * IAState defines a UI state in the FSM.
 *
 * @template TMetadata - Type of metadata returned by identify and passed to reduce
 */
export interface IAState<TMetadata = unknown> {
  fsm: "mainWindow" | "popup" | "contactCard";
  id: string;
  identify: (args: IdentifyArgs) => IdentifyResult<TMetadata>;
  reduce: (args: ReduceArgs<TMetadata>) => AppState;
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
  db: DatabaseInstance;
}

export type EffectWatcher = (args: EffectWatcherArgs) => Effect[];


// ============================================
// Context
// ============================================

export interface Context {
  sessionId: string;
  session: Session;
  db: DatabaseInstance;
  state: AppState;
  save(): Promise<void>;
  load(): Promise<void>;
}

// ============================================
// Plan
// ============================================

// Forward declaration - actual interface is in ia/index.ts
// This avoids circular dependencies
export interface IdentifiedStatesRef {
  mainWindow: { state: IAState; metadata?: unknown } | null;
  popup: { state: IAState; metadata?: unknown } | null;
  contactCard: { state: IAState; metadata?: unknown } | null;
}

export interface PlanArgs<TParams extends ActionParams = ActionParams, TPlanState = unknown> {
  state: AppState;
  params: TParams;
  db: DatabaseInstance;
  sessionId: string;  // For plan-level DB writes
  a11y: A11yNode;
  identified: IdentifiedStatesRef;
  /** Plan-local state - mutable, lives only during execution */
  planState: TPlanState;
}

/**
 * Result from selectAction - bundles the action with its target metadata.
 * The metadata contains the frame reference for scoped execution.
 */
export interface SelectedAction {
  action: Action;
  metadata?: unknown;
}

export interface Plan<TParams extends ActionParams = ActionParams, TPlanState = unknown> {
  id: string;
  description: string;
  params: z.ZodSchema<TParams>;
  /** Initial plan-local state - called once when execution starts */
  initialPlanState?: () => TPlanState;
  isGoalReached: (args: Omit<PlanArgs<TParams, TPlanState>, "a11y" | "identified">) => boolean;
  /** Returns SelectedAction with action + metadata (or null if no action needed) */
  selectAction: (args: PlanArgs<TParams, TPlanState>) => SelectedAction | null;
}

// ============================================
// Execution
// ============================================

export type ExecutionStatus = "running" | "succeeded" | "failed" | "aborted";

export interface Execution<TParams = unknown, TPlanState = unknown> {
  id: string;
  plan: Plan<TParams & ActionParams, TPlanState>;
  params: TParams;
  context: Context;
  status: ExecutionStatus;
  stepCount: number;
  lastAction?: Action;
  error?: string;
  abortSignal: AbortSignal;
  emit: (event: SubscriptionEvent) => void;
  /** Plan-local state - not persisted, lives only during execution */
  planState: TPlanState;
}

// ============================================
// Default State
// ============================================

export function createDefaultAppState(): AppState {
  return {
    mainWindow: { view: "login_qr", isLoggedIn: false },
    popup: null,
    contactCard: null,
  };
}
