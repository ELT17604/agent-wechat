import type { Action, ActionParams } from "./types.js";

/**
 * Action creator functions.
 *
 * Each function takes ActionParams and returns an Action.
 * The selectors use CSS-like syntax.
 */
export const actions: Record<string, (params: ActionParams) => Action> = {
  // ============================================
  // Login Actions
  // ============================================

  /**
   * Click "Log In" button for existing account.
   */
  click_login: () => ({
    type: "click",
    selector: 'push-button[name="Log In"]',
  }),

  /**
   * Click "Switch Account" button for new account.
   */
  click_switch_account: () => ({
    type: "click",
    selector: 'push-button[name="Switch Account"]',
  }),

  // ============================================
  // Chat List Actions
  // ============================================

  /**
   * Click a chat by index (nth-child is 1-indexed like CSS).
   */
  click_chat: (p: ActionParams) => ({
    type: "click",
    selector: `list[name="Chats"] > list-item:nth-child(${(p.index ?? 0) + 1})`,
  }),

  /**
   * Scroll down in the chat list.
   */
  scroll_chats: () => ({
    type: "scroll",
    direction: "down" as const,
    x: 200,
    y: 400,
  }),

  /**
   * Scroll up in the chat list.
   */
  scroll_chats_up: () => ({
    type: "scroll",
    direction: "up" as const,
    x: 200,
    y: 400,
  }),

  // ============================================
  // Search Actions
  // ============================================

  /**
   * Click the search input to open search.
   */
  open_search: () => ({
    type: "click",
    selector: 'text[name="Search"]',
  }),

  /**
   * Type search query.
   */
  type_search: (p: ActionParams) => ({
    type: "type",
    text: p.query ?? p.chatName ?? "",
  }),

  /**
   * Click a search result by index.
   */
  click_search_result: (p: ActionParams) => ({
    type: "click",
    selector: `list > list-item:nth-child(${(p.index ?? 0) + 1})`,
  }),

  /**
   * Cancel search (press Escape).
   */
  cancel_search: () => ({
    type: "key",
    combo: "Escape",
  }),

  // ============================================
  // Message Actions
  // ============================================

  /**
   * Scroll up in the message list (to see older messages).
   */
  scroll_messages_up: () => ({
    type: "scroll",
    direction: "up" as const,
    x: 800,
    y: 400,
  }),

  /**
   * Scroll down in the message list (to see newer messages).
   */
  scroll_messages_down: () => ({
    type: "scroll",
    direction: "down" as const,
    x: 800,
    y: 400,
  }),

  /**
   * Type a message in the input field.
   */
  type_message: (p: ActionParams) => ({
    type: "type",
    text: p.message ?? "",
    selector: "text", // First text input
  }),

  /**
   * Send the typed message (press Enter).
   */
  send_message: () => ({
    type: "key",
    combo: "Return",
  }),

  // ============================================
  // Popup Actions
  // ============================================

  /**
   * Dismiss popup by clicking OK/Confirm button.
   */
  dismiss_popup: () => ({
    type: "click",
    selector: 'push-button[name=/OK|Confirm|确定|确认/i]',
  }),

  /**
   * Cancel popup by clicking Cancel button.
   */
  cancel_popup: () => ({
    type: "click",
    selector: 'push-button[name=/Cancel|取消/i]',
  }),

  // ============================================
  // Utility Actions
  // ============================================

  /**
   * Wait for specified milliseconds.
   */
  wait: (p: ActionParams) => ({
    type: "wait",
    ms: 1000,
  }),
};
