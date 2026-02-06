import type { IAState, SearchResult, FrameIdentifyMetadata, Bounds, A11yNode, ReduceArgs } from "../types.js";
import { querySelector, findAncestor } from "../selectors.js";
import { extractActiveChatId } from "../helpers.js";
import { extractWindowControlBounds } from "./base.js";

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
 * Base chat reducer - handles search state and window bounds.
 */
function chatReduceBase(
  args: ReduceArgs<FrameIdentifyMetadata>
): {
  selectedChatId?: string;
  searchQuery?: string;
  searchResults?: SearchResult[];
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

  return {
    selectedChatId: prev.mainWindow.selectedChatId,
    searchQuery,
    searchResults,
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
 */
export const chatState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "chat",

  identify: ({ a11y }) => {
    if (!isChatView(a11y)) return { identified: false };

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
        openedChatName: undefined,
        openedChatIsGroup: undefined,
        selectedChatBounds: undefined,
      },
    };
  },
};

/**
 * Chat open state - a chat is selected and showing messages.
 */
export const chatOpenState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "chat_open",

  identify: ({ a11y }) => {
    if (!isChatView(a11y)) return { identified: false };

    const selectedItem = findSelectedChatItem(a11y);
    if (!selectedItem) return { identified: false };

    const mainButton = querySelector(a11y, 'push-button[name="Weixin"]') ??
                       querySelector(a11y, 'push-button[name="WeChat"]');
    const frame = mainButton ? findAncestor(mainButton, "frame") : null;
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: (args) => {
    const { a11y } = args;
    const base = chatReduceBase(args);

    // Extract opened chat name from header area
    const chatList = querySelector(a11y, 'list[name="Chats"]');
    const chatListRight = chatList?.bounds ? chatList.bounds.x + chatList.bounds.width : 272;

    const allLabels: A11yNode[] = [];
    const collectLabels = (node: A11yNode) => {
      if (node.role === "label" && node.name && node.bounds) {
        allLabels.push(node);
      }
      node.children?.forEach(collectLabels);
    };
    collectLabels(a11y);

    const headerLabel = allLabels.find(label =>
      label.bounds &&
      label.bounds.x > chatListRight &&
      label.bounds.y < 70 &&
      label.name &&
      label.name.length > 0 &&
      !label.name.includes("Send")
    );
    const rawOpenedChatName = headerLabel?.name;

    // Detect group chat via "(n)" member count pattern
    const memberCountMatch = rawOpenedChatName?.match(/\((\d+)\)$/);
    const isGroup = memberCountMatch !== null;
    const openedChatName = isGroup
      ? rawOpenedChatName?.replace(/\s*\(\d+\)$/, "").trim()
      : rawOpenedChatName;

    // Find the selected chat bounds
    const selectedItem = chatList?.children?.find(item =>
      item.states?.includes("SELECTED")
    );
    const selectedChatBounds = selectedItem?.bounds;

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
        selectedChatBounds,
      },
    };
  },
};

export const chatStates: IAState<FrameIdentifyMetadata>[] = [chatState, chatOpenState];
export type ChatState = typeof chatState | typeof chatOpenState;
