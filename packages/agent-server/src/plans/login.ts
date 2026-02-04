import { z } from "zod";
import type { Plan, ActionParams, SelectedAction, PlanArgs } from "../ia/types.js";
import { LoginActions, PopupActions, WindowActions, CommonActions } from "../ia/actions.js";
import { ContactCardActions } from "../ia/index.js";
import { getSessionLoggedInUser, clearSessionChatData, updateSessionLoggedInUser } from "../db/queries.js";

/**
 * Login plan params
 */
export interface LoginParams extends ActionParams {
  newAccount?: boolean;
}

const loginParamsSchema = z.object({
  newAccount: z.boolean().default(false),
});

/**
 * Login phases - minimal tracking, most state derived from IAState/AppState:
 * - authenticating: in login_* views (derived, no tracking needed)
 * - maximized: we sent maximize command, now click avatar
 * - contact_card_read: we saw contact card and grabbed ID, now dismiss
 * - done: complete
 */
type LoginPhase = "authenticating" | "maximized" | "contact_card_read" | "done";

interface LoginPlanState {
  phase: LoginPhase;
  extractedUserId?: string;
  lastEmittedQr?: string;
  emittedPhoneConfirm?: boolean;
}

/**
 * Login Plan
 *
 * Navigates the WeChat login flow from any state to logged-in state.
 * Also extracts the logged-in user's WeChat ID from their contact card.
 *
 * States handled:
 * - login_qr: Wait for QR code scan, emit QR to client
 * - login_account: Click "Log In" or "Switch Account"
 * - login_phone_confirm: Wait for phone confirmation, emit to client
 * - login_loading: Wait for app to load
 * - chat/chat_open: Maximize, click avatar to get contact card, extract user ID
 * - popup: Dismiss any popup dialogs
 * - contactCard: Extract WeChat ID, dismiss
 */
export const loginPlan: Plan<LoginParams, LoginPlanState> = {
  id: "login",
  description: "Log into WeChat",
  params: loginParamsSchema,

  initialPlanState: () => ({
    phase: "authenticating",
    emittedPhoneConfirm: false,
  }),

  isGoalReached: ({ state, planState }) => {
    return (
      (state.mainWindow.view === "chat" || state.mainWindow.view === "chat_open") &&
      state.popup === null &&
      state.contactCard === null &&
      planState.phase === "done"
    );
  },

  selectAction: ({ state, params, identified, planState, db, sessionId }): SelectedAction | null => {
    const mainMeta = identified.mainWindow?.metadata;

    // === CONTACT CARD (separate FSM) ===
    if (state.contactCard !== null) {
      // Grab the ID (plan knows this is self-user context)
      if (state.contactCard.wechatId && !planState.extractedUserId) {
        planState.extractedUserId = state.contactCard.wechatId;
        // Clear stale chat data if account switched
        const previousUser = getSessionLoggedInUser(db, sessionId);
        if (previousUser && previousUser !== state.contactCard.wechatId) {
          clearSessionChatData(db, sessionId);
        }
        updateSessionLoggedInUser(db, sessionId, state.contactCard.wechatId);
      }
      planState.phase = "contact_card_read";
      // Dismiss the card
      return {
        action: ContactCardActions.DISMISS,
        metadata: identified.contactCard?.metadata,
      };
    }

    // === POPUPS (error/confirm/info) ===
    if (state.popup !== null && identified.popup) {
      return {
        action: PopupActions.DISMISS,
        metadata: identified.popup.metadata,
      };
    }

    // === LOGIN VIEWS (with emissions) ===
    switch (state.mainWindow.view) {
      case "login_qr": {
        // Emit QR if changed
        const qrData = state.mainWindow.qrData;
        if (qrData && qrData !== planState.lastEmittedQr) {
          planState.lastEmittedQr = qrData;
          return {
            action: {
              type: "sequence",
              actions: [
                {
                  type: "emit",
                  event: {
                    type: "qr",
                    qrData: state.mainWindow.qrData,
                    qrBinaryData: state.mainWindow.qrBinaryData,
                  },
                },
                CommonActions.WAIT,
              ],
            },
            metadata: mainMeta,
          };
        }
        return { action: CommonActions.WAIT, metadata: mainMeta };
      }

      case "login_account":
        return {
          action: params.newAccount ? LoginActions.CLICK_SWITCH_ACCOUNT : LoginActions.CLICK_LOGIN,
          metadata: mainMeta,
        };

      case "login_phone_confirm": {
        // Emit phone_confirm once
        if (!planState.emittedPhoneConfirm) {
          planState.emittedPhoneConfirm = true;
          return {
            action: {
              type: "sequence",
              actions: [
                {
                  type: "emit",
                  event: { type: "phone_confirm", message: "Please confirm login on your phone" },
                },
                CommonActions.WAIT,
              ],
            },
            metadata: mainMeta,
          };
        }
        return { action: CommonActions.WAIT, metadata: mainMeta };
      }

      case "login_loading":
        return { action: CommonActions.WAIT, metadata: mainMeta };

      case "chat":
      case "chat_open": {
        // Phase: authenticating -> send maximize -> transition to maximized
        if (planState.phase === "authenticating") {
          planState.phase = "maximized";
          return {
            action: {
              type: "sequence",
              actions: [
                CommonActions.WAIT_LONG,
                WindowActions.MAXIMIZE,
                CommonActions.WAIT,
              ],
            },
            metadata: mainMeta,
          };
        }

        // Phase: maximized -> click avatar (contact card will open)
        if (planState.phase === "maximized") {
          const frameBounds = (mainMeta as { frame?: { bounds?: { x: number; y: number } } } | undefined)?.frame?.bounds;
          if (frameBounds) {
            return {
              action: {
                type: "sequence",
                actions: [
                  { type: "click", x: frameBounds.x + 31, y: frameBounds.y + 41 },
                  CommonActions.WAIT,
                ],
              },
              metadata: mainMeta,
            };
          }
          // No frame bounds - skip user extraction, go to done
          planState.phase = "done";
          return {
            action: {
              type: "sequence",
              actions: [
                { type: "emit", event: { type: "login_success" } },
                CommonActions.WAIT_SHORT,
              ],
            },
            metadata: mainMeta,
          };
        }

        // Phase: contact_card_read -> card dismissed, emit success, done
        if (planState.phase === "contact_card_read") {
          planState.phase = "done";
          return {
            action: {
              type: "sequence",
              actions: [
                {
                  type: "emit",
                  event: {
                    type: "login_success",
                    userId: planState.extractedUserId,
                  },
                },
                CommonActions.WAIT_SHORT,
              ],
            },
            metadata: mainMeta,
          };
        }

        // Phase: done - goal check will catch this after action
        return { action: CommonActions.WAIT_SHORT, metadata: mainMeta };
      }

      default:
        return null;
    }
  },
};
