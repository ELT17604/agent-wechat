import type { IAState, SearchResult, FrameIdentifyMetadata, Bounds, A11yNode, VisibleChat, ReduceArgs } from "../types.js";
import { querySelector, findAncestor } from "../selectors.js";
import { extractActiveChatId } from "../helpers.js";
import { extractWindowControlBounds } from "./base.js";
import { parseChatHead } from "../../lib/chat-parser.js";
import { matchChatWithDb, DEFAULT_AVATAR_HASH } from "../../lib/chat-matcher.js";
import { extractChatHeadHashSync } from "../../lib/chat-image.js";

/**
 * Helper to check base chat view conditions.
 */
function isChatView(a11y: A11yNode): boolean {
  const mainButton = querySelector(a11y, 'push-button[name="Weixin"]') ??
                     querySelector(a11y, 'push-button[name="WeChat"]');
  if (!mainButton) return false;

  const hasContactsButton = querySelector(a11y, 'push-button[name="Contacts"]') !== null;
  const hasChatsList = querySelector(a11y, 'list[name="Chats"]') !== null;

  return hasContactsButton && hasChatsList;
}

/**
 * Base chat reducer - handles search state, focus tracking, and sync progress.
 * Called by both chat and chat_open states.
 */
function chatReduceBase(
  args: ReduceArgs<FrameIdentifyMetadata>
): {
  selectedChatId?: string;
  searchQuery?: string;
  searchResults?: SearchResult[];
  visibleChats?: VisibleChat[];
  focusedChatIndex?: number;
  focusedChatName?: string;
  closeButtonBounds?: Bounds;
  minimizeButtonBounds?: Bounds;
  maximizeButtonBounds?: Bounds;
} {
  const { prev, a11y, metadata } = args;

  // Check for search state
  const chatList = querySelector(a11y, 'list[name="Chats"]');
  const searchInput = querySelector(a11y, 'text[name="Search"]');
  const searchDropdown = querySelector(a11y, 'list');

  let searchQuery: string | undefined;
  let searchResults: SearchResult[] | undefined;

  if (searchInput && searchDropdown && searchDropdown !== chatList) {
    if (
      searchInput.bounds &&
      searchDropdown.bounds &&
      searchDropdown.bounds.y > searchInput.bounds.y + searchInput.bounds.height
    ) {
      searchQuery = "";
      searchResults = searchDropdown.children
        ?.filter((c) => c.role === "list-item")
        .map((r) => ({ name: r.name, bounds: r.bounds })) ?? [];
    }
  }

  const windowBounds = extractWindowControlBounds(metadata?.frame);

  // Find list items and track focused item by AT-SPI state
  const listItems = chatList?.children?.filter((c) => c.role === "list-item") ?? [];
  const focusedIndex = listItems.findIndex(item => item.states?.includes("FOCUSED"));
  const focusedItem = focusedIndex >= 0 ? listItems[focusedIndex] : undefined;

  // Parse visible chats for name-based matching (still useful for watchers)
  const visibleChats: VisibleChat[] = [];
  for (const item of listItems) {
    if (!item.name) continue;

    const parseResult = parseChatHead(item.name);
    const match = matchChatWithDb(args.db, parseResult, "");

    visibleChats.push({
      id: match.id,
      name: match.name,
      imageHash: null,
      bounds: item.bounds,
      unreadCount: parseResult.unreadCount,
      time: parseResult.time,
      pinned: parseResult.pinned,
      muted: parseResult.muted,
      preview: parseResult.candidates[0]?.preview,
      sender: parseResult.candidates[0]?.sender,
      matchConfidence: match.confidence,
      shouldUpdateName: match.shouldUpdateName,
    });
  }

  return {
    selectedChatId: prev.mainWindow.selectedChatId,
    searchQuery,
    searchResults,
    visibleChats: visibleChats.length > 0 ? visibleChats : prev.mainWindow.visibleChats,
    focusedChatIndex: focusedIndex >= 0 ? focusedIndex : undefined,
    focusedChatName: focusedItem?.name,
    ...windowBounds,
  };
}

/**
 * Helper to find selected item in chat list.
 */
function findSelectedChatItem(a11y: A11yNode): A11yNode | undefined {
  const chatList = querySelector(a11y, 'list[name="Chats"]');
  return chatList?.children?.find(item => item.states?.includes("SELECTED"));
}

/**
 * Chat state - no chat selected.
 *
 * In this state, keyboard navigation (Page_Down, Home, etc.) works on the chat list.
 * This is detected by no SELECTED item in the Chats list.
 */
export const chatState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "chat",

  identify: ({ a11y }) => {
    if (!isChatView(a11y)) return { identified: false };

    // No SELECTED item in chat list = no chat open
    const selectedItem = findSelectedChatItem(a11y);
    if (selectedItem) return { identified: false };

    const mainButton = querySelector(a11y, 'push-button[name="Weixin"]') ??
                       querySelector(a11y, 'push-button[name="WeChat"]');
    const frame = mainButton ? findAncestor(mainButton, "frame") : null;
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: (args) => {
    const base = chatReduceBase(args);

    return {
      ...args.prev,
      mainWindow: {
        view: "chat",
        isLoggedIn: true,
        ...base,
        // Clear chat_open specific fields
        openedChatName: undefined,
        openedChatIsGroup: undefined,
        openedChatImageHash: undefined,
        selectedChatBounds: undefined,
      },
    };
  },
};

/**
 * Chat open state - a chat is selected and showing messages.
 *
 * In this state, keyboard navigation affects the message view, not the chat list.
 * This is detected by a SELECTED item in the Chats list.
 */
export const chatOpenState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "chat_open",

  identify: ({ a11y }) => {
    if (!isChatView(a11y)) return { identified: false };

    // SELECTED item in chat list = chat is open
    const selectedItem = findSelectedChatItem(a11y);
    if (!selectedItem) return { identified: false };

    const mainButton = querySelector(a11y, 'push-button[name="Weixin"]') ??
                       querySelector(a11y, 'push-button[name="WeChat"]');
    const frame = mainButton ? findAncestor(mainButton, "frame") : null;
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: (args) => {
    const { a11y, screenshot } = args;
    const base = chatReduceBase(args);

    // Extract opened chat name from header area
    // The name label is in a sibling subtree to Chat Info button, so find by position:
    // - Header region: x > 272 (after chat list), y < 70 (header row)
    // - Look for a label with non-empty name in that region
    const chatList = querySelector(a11y, 'list[name="Chats"]');
    const chatListRight = chatList?.bounds ? chatList.bounds.x + chatList.bounds.width : 272;

    // Find all labels and filter to header region
    const allLabels: A11yNode[] = [];
    const collectLabels = (node: A11yNode) => {
      if (node.role === "label" && node.name && node.bounds) {
        allLabels.push(node);
      }
      node.children?.forEach(collectLabels);
    };
    collectLabels(a11y);

    // Header label: after chat list, in top 70px, with substantial name
    const headerLabel = allLabels.find(label =>
      label.bounds &&
      label.bounds.x > chatListRight &&
      label.bounds.y < 70 &&
      label.name &&
      label.name.length > 0 &&
      !label.name.includes("Send") // Exclude button labels
    );
    const rawOpenedChatName = headerLabel?.name;

    // Detect group chat via "(n)" member count pattern in header
    // Groups show: "Group Name (123)" where 123 is member count
    const memberCountMatch = rawOpenedChatName?.match(/\((\d+)\)$/);
    const isGroup = memberCountMatch !== null;
    const openedChatName = isGroup
      ? rawOpenedChatName?.replace(/\s*\(\d+\)$/, "").trim()
      : rawOpenedChatName;

    // Find the selected chat in the list by SELECTED state (more reliable than name matching)
    const selectedItem = chatList?.children?.find(item =>
      item.states?.includes("SELECTED")
    );
    const selectedChatBounds = selectedItem?.bounds;

    // Extract image hash from selected item bounds
    const rawImageHash = extractChatHeadHashSync(screenshot, selectedChatBounds);
    // Filter out placeholder hash - don't store or use for matching
    // Convert null to undefined for type compatibility
    const imageHash = (rawImageHash === DEFAULT_AVATAR_HASH || rawImageHash === null)
      ? undefined
      : rawImageHash;

    // Try to get active chat ID
    const msgList = querySelector(a11y, 'list[name="Messages"]');
    let selectedChatId = base.selectedChatId;
    if (msgList) {
      const activeChatId = extractActiveChatId(a11y);
      if (activeChatId) {
        selectedChatId = activeChatId;
      }
    }

    return {
      ...args.prev,
      mainWindow: {
        view: "chat_open",
        isLoggedIn: true,
        ...base,
        selectedChatId,
        openedChatName,
        openedChatIsGroup: isGroup,
        openedChatImageHash: imageHash,
        selectedChatBounds,
      },
    };
  },
};

export const chatStates: IAState<FrameIdentifyMetadata>[] = [chatState, chatOpenState];
export type ChatState = typeof chatState | typeof chatOpenState;
