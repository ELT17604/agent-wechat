/**
 * Action constants organized by domain.
 *
 * Usage in plans:
 *   import { LoginActions, ChatActions, PopupActions } from "../ia/actions.js";
 *   return LoginActions.CLICK_LOGIN;
 */

import type { Action } from "./types.js";

// ============================================
// Common Actions
// ============================================

export const CommonActions = {
  WAIT: { type: "wait", ms: 500 } as Action,
  WAIT_SHORT: { type: "wait", ms: 200 } as Action,
  WAIT_LONG: { type: "wait", ms: 1000 } as Action,
} as const;

// ============================================
// Window Control Actions
// ============================================

export const WindowActions = {
  MAXIMIZE: { type: "click", selector: 'tool-bar push-button[name="Maximize"]' } as Action,
  MINIMIZE: { type: "click", selector: 'tool-bar push-button[name="Minimize"]' } as Action,
  CLOSE: { type: "click", selector: 'tool-bar push-button[name="Disable"]' } as Action,
} as const;

// ============================================
// Login Actions
// ============================================

export const LoginActions = {
  CLICK_LOGIN: { type: "click", selector: 'push-button[name=/^(Log In|Open WeChat)$/]' } as Action,
  CLICK_SWITCH_ACCOUNT: { type: "click", selector: 'push-button[name="Switch Account"]' } as Action,
  WAIT: CommonActions.WAIT,
} as const;

// ============================================
// Popup Actions
// ============================================

export const PopupActions = {
  DISMISS: { type: "click", selector: 'push-button[name=/OK|Confirm|确定|确认/i]' } as Action,
  CANCEL: { type: "click", selector: 'push-button[name=/Cancel|取消/i]' } as Action,
} as const;

// ============================================
// Chat Actions
// ============================================

export const ChatActions = {
  // Navigation
  HOME: { type: "key", combo: "Home" } as Action,
  END: { type: "key", combo: "End" } as Action,
  PAGE_DOWN: { type: "key", combo: "Page_Down" } as Action,
  PAGE_UP: { type: "key", combo: "Page_Up" } as Action,

  // Tab switching
  SWITCH_TO_CHATS: { type: "key", combo: "ctrl+1" } as Action,
  SWITCH_TO_CONTACTS: { type: "key", combo: "ctrl+2" } as Action,

  // Window
  MAXIMIZE: WindowActions.MAXIMIZE,

  // Wait
  WAIT: CommonActions.WAIT,
  WAIT_FOR_IMAGES: { type: "wait", ms: 100 } as Action,
} as const;

// ============================================
// Helper to create dynamic click action
// ============================================

export function clickAt(x: number, y: number): Action {
  return { type: "click", x, y };
}

export function clickBounds(bounds: { x: number; y: number; width: number; height: number }): Action {
  return clickAt(
    Math.round(bounds.x + bounds.width / 2),
    Math.round(bounds.y + bounds.height / 2)
  );
}
