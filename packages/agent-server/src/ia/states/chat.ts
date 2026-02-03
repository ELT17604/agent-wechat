import type { IAState, SearchResult, ActionParams, FrameIdentifyMetadata } from "../types.js";
import { querySelector, querySelectorAll, findAncestor } from "../selectors.js";
import { parseChat, parseMessage, extractActiveChatId } from "../helpers.js";
import { windowControlCommands, extractWindowControlBounds } from "./base.js";

/**
 * Chat state - WeChat main view with chat list and message view.
 *
 * This is a combined state that represents the logged-in main window.
 * It handles chat list, message view, and search overlay.
 */
export const chatState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "chat",

  identify: ({ a11y }) => {
    // Must have all: (Weixin OR WeChat button) + Contacts button + Chats list
    const mainButton = querySelector(a11y, 'push-button[name="Weixin"]') ??
                       querySelector(a11y, 'push-button[name="WeChat"]');
    if (!mainButton) return { identified: false };

    const hasContactsButton = querySelector(a11y, 'push-button[name="Contacts"]') !== null;
    const hasChatsList = querySelector(a11y, 'list[name="Chats"]') !== null;

    if (!hasContactsButton || !hasChatsList) return { identified: false };

    // Find the containing frame
    const frame = findAncestor(mainButton, "frame");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: ({ prev, a11y, metadata }) => {
    // Extract chat list
    const chatList = querySelector(a11y, 'list[name="Chats"]');
    const visibleChats = chatList?.children?.map(parseChat) ?? [];

    // Extract message list if present
    const msgList = querySelector(a11y, 'list[name="Messages"]');
    const visibleMessages = msgList?.children?.map(item => parseMessage(item)) ?? [];

    // Try to determine selected chat
    let selectedChatId = prev.mainWindow.selectedChatId;
    if (msgList) {
      // If we have messages open, try to get the active chat ID
      const activeChatId = extractActiveChatId(a11y);
      if (activeChatId) {
        selectedChatId = activeChatId;
      }
    }

    // Check for search state
    const searchInput = querySelector(a11y, 'text[name="Search"]');
    const searchDropdown = querySelector(a11y, 'list');

    // Heuristic: search is active if input is focused or dropdown is below search
    let searchQuery: string | undefined;
    let searchResults: SearchResult[] | undefined;

    // Simple check: if there's a focused search input, we're in search mode
    // This is a simplified version - real detection would need more context
    if (searchInput && searchDropdown && searchDropdown !== chatList) {
      // Check if dropdown is positioned below search (indicating search results)
      if (
        searchInput.bounds &&
        searchDropdown.bounds &&
        searchDropdown.bounds.y > searchInput.bounds.y + searchInput.bounds.height
      ) {
        searchQuery = ""; // We can't easily get the typed text from a11y
        searchResults = searchDropdown.children
          ?.filter((c) => c.role === "list-item")
          .map((r) => ({ name: r.name, bounds: r.bounds })) ?? [];
      }
    }

    const windowBounds = extractWindowControlBounds(metadata?.frame);

    return {
      ...prev,
      mainWindow: {
        view: "chat",
        selectedChatId,
        searchQuery,
        searchResults,
        ...windowBounds,
      },
    };
  },

  commands: {
    // Chat list actions
    click_chat: (p: ActionParams) => ({
      type: "click" as const,
      selector: `list[name="Chats"] > list-item:nth-child(${(p.index ?? 0) + 1})`,
    }),
    scroll_chats: { type: "scroll", direction: "down" as const, x: 200, y: 400 },
    scroll_chats_up: { type: "scroll", direction: "up" as const, x: 200, y: 400 },

    // Search actions
    open_search: { type: "click", selector: 'text[name="Search"]' },
    type_search: (p: ActionParams) => ({ type: "type" as const, text: p.query ?? p.chatName ?? "" }),
    click_search_result: (p: ActionParams) => ({
      type: "click" as const,
      selector: `list > list-item:nth-child(${(p.index ?? 0) + 1})`,
    }),
    cancel_search: { type: "key", combo: "Escape" },

    // Message actions
    scroll_messages_up: { type: "scroll", direction: "up" as const, x: 800, y: 400 },
    scroll_messages_down: { type: "scroll", direction: "down" as const, x: 800, y: 400 },
    type_message: (p: ActionParams) => ({ type: "type" as const, text: p.message ?? "", selector: "text" }),
    send_message: { type: "key", combo: "Return" },

    // Sequence: type and send atomically
    type_and_send: (p: ActionParams) => ({
      type: "sequence" as const,
      actions: [
        { type: "type" as const, text: p.message ?? "", selector: "text" },
        { type: "wait" as const, ms: 100 },
        { type: "key" as const, combo: "Return" },
      ],
    }),

    // Window controls
    ...windowControlCommands,
  },
};

export const chatStates: IAState<FrameIdentifyMetadata>[] = [chatState];
