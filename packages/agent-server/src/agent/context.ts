import type { Session, LoginSubscriptionEvent } from "@thisnick/agent-wechat-shared";

/**
 * Options for the login flow
 */
export interface LoginOptions {
  /** If true, click "Switch Account" instead of using existing account */
  newAccount?: boolean;
}

/**
 * Context passed to agent tools via experimental_context.
 * Provides session info, WebSocket emitter, and abort signal.
 */
export interface AgentContext {
  /** The session to operate on (display, dbus, user) */
  session: Session;
  /** Emit events to the WebSocket client */
  emit: (event: LoginSubscriptionEvent) => void;
  /** Triggered by WS disconnect OR timeout */
  abortSignal: AbortSignal;
  /** Login-specific options */
  loginOptions?: LoginOptions;
}

/**
 * Login-specific context (same as AgentContext but with explicit typing)
 */
export type LoginContext = AgentContext;
