import { z } from "zod";
import type { Plan, ActionParams, SelectedAction } from "../ia/types.js";
import { PopupActions, CommonActions } from "../ia/actions.js";
import { querySelector } from "../ia/selectors.js";
import { openChat, type OpenChatResult } from "../lib/chat-select.js";

export interface ChatOpenParams extends ActionParams {
  chatId: string;
}

const chatOpenParamsSchema = z.object({
  chatId: z.string(),
});

type ChatOpenPhase = "pending" | "done";

interface ChatOpenPlanState {
  phase: ChatOpenPhase;
  result?: OpenChatResult;
}

/**
 * Chat Open Plan
 *
 * Opens a specific chat in the WeChat UI using the FSM architecture.
 *
 * Behavior depends on IA state:
 * - `chat_open` (a chat is already selected): Uses current-selection detection
 *   to skip if the target is already open.
 * - `chat` (no chat selected): Always selects with --force since memory-based
 *   detection may be stale after deselect.
 *
 * The plan finds click target coordinates from the a11y tree and passes them
 * to the chat-select tool, which handles Frida hook installation and clicking.
 */
export const chatOpenPlan: Plan<ChatOpenParams, ChatOpenPlanState> = {
  id: "chat_open",
  description: "Open a specific chat in WeChat",
  params: chatOpenParamsSchema,

  initialPlanState: () => ({
    phase: "pending",
  }),

  isGoalReached: ({ planState }) => {
    return planState.phase === "done";
  },

  selectAction: async ({ state, params, identified, planState, a11y }): Promise<SelectedAction | null> => {
    const mainMeta = identified.mainWindow?.metadata;

    // Dismiss popups first
    if (state.popup !== null && identified.popup) {
      return {
        action: PopupActions.DISMISS,
        metadata: identified.popup.metadata,
      };
    }

    // Must be in chat or chat_open view (i.e., logged in with chat list visible)
    const mainStateId = identified.mainWindow?.state.id;
    if (mainStateId !== "chat" && mainStateId !== "chat_open") {
      return null; // Error: not in a valid state for chat opening
    }

    // Find click target from a11y tree
    const chatListItem = querySelector(a11y, 'list[name="Chats"] > list-item');
    let clickXY: { x: number; y: number } | undefined;
    if (chatListItem?.bounds) {
      clickXY = {
        x: Math.round(chatListItem.bounds.x + chatListItem.bounds.width / 2),
        y: Math.round(chatListItem.bounds.y + chatListItem.bounds.height / 2),
      };
    }

    // Force when IA is "chat" (no chat selected) — memory detection may be stale
    const force = mainStateId === "chat";

    // Call chat-select tool (async — doesn't block event loop)
    const result = await openChat(params.chatId, { force, clickXY });

    planState.result = result;
    planState.phase = "done";
    return { action: CommonActions.WAIT_SHORT, metadata: mainMeta };
  },
};
