import { z } from "zod";
import type { Plan, ActionParams, SelectedAction, Action, A11yNode } from "../ia/types.js";
import { PopupActions, CommonActions, clickBounds } from "../ia/actions.js";
import { querySelector } from "../ia/selectors.js";
import { openChat, type OpenChatResult } from "../lib/chat-select.js";
import { execCommand } from "../lib/exec.js";

export interface SendMessageParams extends ActionParams {
  chatId: string;
  message?: string;
  imagePath?: string;
  imageMime?: string;
}

const sendMessageParamsSchema = z.object({
  chatId: z.string(),
  message: z.string().optional(),
  imagePath: z.string().optional(),
  imageMime: z.string().optional(),
});

type SendMessagePhase =
  | "opening"
  | "focusing"
  | "inputting"
  | "confirming"
  | "done";

interface SendMessagePlanState {
  phase: SendMessagePhase;
  openResult?: OpenChatResult;
  confirmAttempts: number;
}

/**
 * Find the Send(S) button and adjacent editable text component.
 *
 * A11y tree structure:
 *   - text "..." [EDITABLE,FOCUSED] @(...)
 *     - filler [FOCUSED] @(...)
 *   - push-button "Send(S)" @(...)
 *     - label "Send(S)" @(...)
 *
 * The edit and Send button are siblings under the same parent.
 */
function findEditAndSendButton(a11y: A11yNode) {
  const sendButton = querySelector(a11y, 'push-button[name="Send(S)"]');
  if (!sendButton?.parent) return null;

  const editNode = sendButton.parent.children?.find(
    (c) => c.role === "text" && c.states?.includes("EDITABLE")
  );
  if (!editNode) return null;

  return { editNode, sendButton };
}

/**
 * Send Message Plan
 *
 * Opens a chat and sends a text message or image via the WeChat UI.
 *
 * Phases fall through when preconditions are already met (no unnecessary waits).
 *
 * Phases:
 *   opening    → Open the target chat (reuses openChat)
 *   focusing   → Find the edit component and focus it
 *   inputting  → Text: Ctrl+A + type + Enter; Image: paste-image + Enter
 *   confirming → Verify Send(S) disabled (message sent)
 *   done       → Goal reached
 */
export const sendMessagePlan: Plan<SendMessageParams, SendMessagePlanState> = {
  id: "send_message",
  description: "Send a text message or image to a chat",
  params: sendMessageParamsSchema,

  initialPlanState: () => ({
    phase: "opening",
    confirmAttempts: 0,
  }),

  isGoalReached: ({ planState }) => {
    return planState.phase === "done";
  },

  selectAction: async ({
    state,
    params,
    identified,
    planState,
    a11y,
  }): Promise<SelectedAction | null> => {
    const mainMeta = identified.mainWindow?.metadata;
    const mainStateId = identified.mainWindow?.state.id;

    // Dismiss popups first (any phase)
    if (state.popup !== null && identified.popup) {
      return {
        action: PopupActions.DISMISS,
        metadata: identified.popup.metadata,
      };
    }

    // Loop allows phases to fall through when preconditions are already met
    while (true) {
      switch (planState.phase) {
        // ── opening: Open the target chat ──
        case "opening": {
          if (mainStateId !== "chat" && mainStateId !== "chat_open") {
            return null; // Not in a valid state for chat opening
          }

          // Find click target from a11y tree (same as chat-open plan)
          const chatListItem = querySelector(
            a11y,
            'list[name="Chats"] > list-item'
          );
          let clickXY: { x: number; y: number } | undefined;
          if (chatListItem?.bounds) {
            clickXY = {
              x: Math.round(
                chatListItem.bounds.x + chatListItem.bounds.width / 2
              ),
              y: Math.round(
                chatListItem.bounds.y + chatListItem.bounds.height / 2
              ),
            };
          }

          // Force when no chat selected (memory detection unreliable)
          const force = mainStateId === "chat";

          const result = await openChat(params.chatId, { force, clickXY });
          planState.openResult = result;

          if (!result.ok) {
            return null; // Chat open failed
          }

          planState.phase = "focusing";

          // Chat actually switched — need to wait for UI to settle
          if (!result.skipped) {
            return { action: CommonActions.WAIT_SHORT, metadata: mainMeta };
          }
          // Chat was already open — fall through to focusing
          continue;
        }

        // ── focusing: Find edit component and focus it ──
        case "focusing": {
          if (mainStateId !== "chat_open") {
            return null; // Chat didn't open
          }

          const found = findEditAndSendButton(a11y);
          if (!found) {
            return null; // Edit component not found
          }

          const { editNode } = found;
          planState.phase = "inputting";

          if (editNode.states?.includes("FOCUSED")) {
            // Already focused — fall through to inputting
            continue;
          }

          // Click to focus the edit component
          if (!editNode.bounds) {
            return null; // No bounds to click
          }
          return { action: clickBounds(editNode.bounds), metadata: mainMeta };
        }

        // ── inputting: Type message + Enter, or paste image + Enter ──
        case "inputting": {
          const found = findEditAndSendButton(a11y);
          if (!found) {
            return null; // Edit component lost
          }

          if (!found.editNode.states?.includes("FOCUSED")) {
            return null; // Focus click didn't work
          }

          planState.phase = "confirming";

          // Image path: paste image via clipboard, then Enter to confirm
          if (params.imagePath) {
            const args = [params.imagePath];
            if (params.imageMime) args.push(params.imageMime);
            await execCommand("paste-image", args);
            return { action: { type: "key", combo: "Return" }, metadata: mainMeta };
          }

          // Text: select all, type message, press Enter to send
          if (!params.message) {
            return null; // Nothing to send
          }

          const inputAndSend: Action = {
            type: "sequence",
            actions: [
              { type: "key", combo: "ctrl+a" },
              { type: "type", text: params.message },
              { type: "key", combo: "Return" },
            ],
          };

          return { action: inputAndSend, metadata: mainMeta };
        }

        // ── confirming: Verify Send(S) disabled (message sent) ──
        case "confirming": {
          const found = findEditAndSendButton(a11y);
          if (!found) {
            return null; // Send button not found
          }

          if (found.sendButton.states?.includes("DISABLED")) {
            // Send button disabled = message was sent successfully
            planState.phase = "done";
            return { action: CommonActions.WAIT_SHORT, metadata: mainMeta };
          }

          // Not disabled yet — retry a few times
          planState.confirmAttempts++;
          if (planState.confirmAttempts >= 5) {
            return null; // Timed out waiting for send confirmation
          }

          return { action: CommonActions.WAIT_SHORT, metadata: mainMeta };
        }

        default:
          return null;
      }
    }
  },
};
