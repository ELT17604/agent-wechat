import { z } from "zod";
import type { Plan, ActionParams, SelectedAction } from "../ia/types.js";
import { upsertChat, findChatByImageHash, findChatsByExactName } from "../db/queries.js";
import { DEFAULT_AVATAR_HASH } from "../lib/chat-matcher.js";

/**
 * Sync chats plan params
 */
export interface SyncChatsParams extends ActionParams {
  maxChats: number;
}

const syncChatsParamsSchema = z.object({
  maxChats: z.number().optional().default(20),
}) as unknown as z.ZodSchema<SyncChatsParams>;

/**
 * Chats to skip during sync
 */
const SKIP_PATTERNS = [
  "File Transfer",
  "文件传输助手",
  "Official Accounts",
  "Service Accounts",
  "订阅号",
  "服务号",
];

function shouldSkipChat(name?: string): boolean {
  if (!name) return false;
  return SKIP_PATTERNS.some(p => name.includes(p));
}

/**
 * Persist chat to database
 */
function persistChat(
  db: Parameters<typeof upsertChat>[0],
  sessionId: string,
  chatName: string,
  isGroup: boolean,
  unreadCount: number,
  rawImageHash?: string
): void {
  const imageHash = rawImageHash === DEFAULT_AVATAR_HASH ? undefined : rawImageHash;

  let existingChat = imageHash ? findChatByImageHash(db, imageHash) : null;
  if (!existingChat) {
    const nameMatches = findChatsByExactName(db, chatName);
    if (nameMatches.length === 1) {
      existingChat = nameMatches[0];
    }
  }

  if (existingChat) {
    upsertChat(db, {
      id: existingChat.id,
      name: chatName,
      imageHash: imageHash ?? existingChat.imageHash,
      isGroup: isGroup || existingChat.isGroup,
      unreadCount,
    }, sessionId);
  } else {
    upsertChat(db, {
      name: chatName,
      imageHash,
      isGroup,
      unreadCount,
      createdAt: new Date().toISOString(),
    }, sessionId);
  }
}

/**
 * Sync plan state
 */
export interface SyncPlanState {
  phase: "init" | "syncing" | "done";
  lastSelectedName: string | null;
  processedCount: number;
  pendingUnreadCount: number;
  lastSkippedIndex?: number;  // Detect end-of-list during skip chains
}

/**
 * Sync Chats Plan - ctrl+Tab navigation with end-of-list detection:
 *
 * 1. Init: Close any open chat, press Home, then ctrl+Tab
 * 2. Loop (no chat open - first item):
 *    - If focused should skip → ctrl+Tab
 *    - Otherwise → note unreadCount, press space
 * 3. Loop (chat open, new chat):
 *    - Persist chat, emit progress, press ctrl+Tab (keep chat open)
 * 4. Loop (chat open, already persisted - checking advance):
 *    - If focusedChatIndex === selectedChatIndex → done (end of list)
 *    - If focused should skip → ctrl+Tab
 *    - Otherwise → note unreadCount, press space (switches to focused chat)
 */
export const syncChatsPlan: Plan<SyncChatsParams, SyncPlanState> = {
  id: "sync_chats",
  description: "Sync chat list by selecting each chat",
  params: syncChatsParamsSchema,

  initialPlanState: () => ({
    phase: "init",
    lastSelectedName: null,
    processedCount: 0,
    pendingUnreadCount: 0,
  }),

  isGoalReached: ({ params, planState }) => {
    if (planState.phase === "done") return true;
    if (params.maxChats && planState.processedCount >= params.maxChats) return true;
    return false;
  },

  selectAction: ({ state, identified, planState, db, sessionId }): SelectedAction | null => {
    const mainMeta = identified.mainWindow?.metadata;
    const view = state.mainWindow.view;
    const selectedBounds = state.mainWindow.selectedChatBounds;
    const openedChatName = state.mainWindow.openedChatName;
    const focusedName = state.mainWindow.focusedChatName;
    const focusedIndex = state.mainWindow.focusedChatIndex;
    const selectedIndex = state.mainWindow.selectedChatIndex;

    // Get unread count from focused item in visibleChats
    const focusedUnread = focusedIndex !== undefined
      ? state.mainWindow.visibleChats?.[focusedIndex]?.unreadCount ?? 0
      : 0;

    // === INIT PHASE ===
    if (planState.phase === "init") {
      // If chat is open, close it first
      if (view === "chat_open") {
        if (selectedBounds) {
          return { action: { type: "click", x: selectedBounds.x + selectedBounds.width / 2, y: selectedBounds.y + selectedBounds.height / 2 }, metadata: mainMeta };
        }
        return { action: { type: "key", combo: "Escape" }, metadata: mainMeta };
      }

      // No chat open - press Home then ctrl+Tab to focus first item
      planState.phase = "syncing";
      return {
        action: {
          type: "sequence",
          actions: [
            { type: "key", combo: "Home" },
            { type: "key", combo: "ctrl+Tab" },
          ],
        },
        metadata: mainMeta,
      };
    }

    // === SYNCING PHASE ===
    if (planState.phase === "syncing") {
      // --- Chat NOT open: evaluate focused item (after init or edge case) ---
      if (view !== "chat_open") {
        if (shouldSkipChat(focusedName)) {
          return { action: { type: "key", combo: "ctrl+Tab" }, metadata: mainMeta };
        }

        planState.pendingUnreadCount = focusedUnread;
        return { action: { type: "key", combo: "space" }, metadata: mainMeta };
      }

      // --- Chat IS open ---

      // New chat (not yet persisted): persist and ctrl+Tab to advance
      if (openedChatName && openedChatName !== planState.lastSelectedName) {
        const imageHash = state.mainWindow.openedChatImageHash;
        const isGroup = state.mainWindow.openedChatIsGroup ?? false;
        persistChat(db, sessionId, openedChatName, isGroup, planState.pendingUnreadCount, imageHash);
        planState.processedCount++;
        planState.lastSelectedName = openedChatName;
        planState.lastSkippedIndex = undefined;

        return {
          action: {
            type: "sequence",
            actions: [
              { type: "emit", event: { type: "sync_progress", processedCount: planState.processedCount } },
              { type: "key", combo: "ctrl+Tab" },
            ],
          },
          metadata: mainMeta,
        };
      }

      // Already persisted - checking if ctrl+Tab advanced

      // End of list: focused item is the same as selected item
      if (focusedIndex !== undefined && selectedIndex !== undefined && focusedIndex === selectedIndex) {
        planState.phase = "done";
        return { action: { type: "wait", ms: 0 }, metadata: mainMeta };
      }

      // Skip system chats
      if (shouldSkipChat(focusedName)) {
        // Detect stuck on same skip item (end of list lands on skip chat)
        if (focusedIndex !== undefined && focusedIndex === planState.lastSkippedIndex) {
          planState.phase = "done";
          return { action: { type: "wait", ms: 0 }, metadata: mainMeta };
        }
        planState.lastSkippedIndex = focusedIndex;
        return { action: { type: "key", combo: "ctrl+Tab" }, metadata: mainMeta };
      }
      planState.lastSkippedIndex = undefined;

      // Advance: note unread count and press space to switch to focused chat
      planState.pendingUnreadCount = focusedUnread;
      return { action: { type: "key", combo: "space" }, metadata: mainMeta };
    }

    // === DONE ===
    return null;
  },
};
