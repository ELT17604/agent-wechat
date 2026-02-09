import { z } from "zod";
import type { Plan, ActionParams, SelectedAction } from "../ia/types.js";
import { LoginActions, PopupActions, WindowActions, CommonActions } from "../ia/actions.js";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { getSessionLoggedInUser, clearSessionData, updateSessionLoggedInUser } from "../db/queries.js";
import { findAccountDir, findWechatPid } from "../lib/wechat-db.js";
import { extractKeys, storeKeys, needsKeyExtraction } from "../lib/wechat-keys.js";

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
 * Login phases:
 * - authenticating: in login_* views (derived, no tracking needed)
 * - maximized: we sent maximize command, now detect user
 * - detecting_user: scan /proc/pid/fd for account directory
 * - extracting_keys: run post-login setup (~20s)
 * - done: complete
 */
type LoginPhase = "authenticating" | "maximized" | "detecting_user" | "extracting_keys" | "done";

interface LoginPlanState {
  phase: LoginPhase;
  accountDir?: string;
  lastEmittedQr?: string;
  emittedPhoneConfirm?: boolean;
  detectRetries: number;
}

/**
 * Login Plan
 *
 * Navigates the WeChat login flow from any state to logged-in state.
 * After login, detects the user account and sets up DB access.
 *
 * States handled:
 * - login_qr: Wait for QR code scan, emit QR to client
 * - login_account: Click "Log In" or "Switch Account"
 * - login_phone_confirm: Wait for phone confirmation, emit to client
 * - login_loading: Wait for app to load
 * - chat/chat_open: Maximize, detect user, setup DB access
 * - popup: Dismiss any popup dialogs
 */
export const loginPlan: Plan<LoginParams, LoginPlanState> = {
  id: "login",
  description: "Log into WeChat",
  params: loginParamsSchema,

  initialPlanState: () => ({
    phase: "authenticating",
    emittedPhoneConfirm: false,
    detectRetries: 0,
  }),

  isGoalReached: ({ state, planState }) => {
    return (
      (state.mainWindow.view === "chat" || state.mainWindow.view === "chat_open") &&
      state.popup === null &&
      planState.phase === "done"
    );
  },

  selectAction: ({ state, params, identified, planState, db, sessionId }): SelectedAction | null => {
    const mainMeta = identified.mainWindow?.metadata;

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

        // Phase: maximized -> detect user account via /proc/pid/fd
        if (planState.phase === "maximized") {
          planState.phase = "detecting_user";
          return { action: CommonActions.WAIT, metadata: mainMeta };
        }

        // Phase: detecting_user -> find account dir from WeChat process
        if (planState.phase === "detecting_user") {
          const detectStart = Date.now();
          // Get PID from session, or detect it dynamically (for default session
          // started by entrypoint.sh where wechatPid isn't tracked in DB)
          // Find WeChat PID: try stored PID first, fall back to pgrep.
          // Stored PID may be stale after container rebuild.
          let wechatPid = db.select({ wechatPid: sessions.wechatPid })
            .from(sessions).where(eq(sessions.id, sessionId)).get()?.wechatPid;

          let accountDir: string | null = null;
          if (wechatPid) {
            accountDir = findAccountDir(wechatPid);
          }

          // Stored PID failed — re-detect
          if (!accountDir) {
            wechatPid = findWechatPid();
            if (wechatPid) {
              accountDir = findAccountDir(wechatPid);
              // Update stored PID
              db.update(sessions)
                .set({ wechatPid, updatedAt: new Date().toISOString() })
                .where(eq(sessions.id, sessionId))
                .run();
            }
          }

          if (wechatPid && accountDir) {
              console.log(`[login] User detection took ${Date.now() - detectStart}ms (pid=${wechatPid}, account=${accountDir})`);
              planState.accountDir = accountDir;

              // Check if account changed
              const previousUser = getSessionLoggedInUser(db, sessionId);
              if (previousUser && previousUser !== accountDir) {
                clearSessionData(db, sessionId);
              }
              updateSessionLoggedInUser(db, sessionId, accountDir);

              // Check if stored keys are valid
              const keyCheckStart = Date.now();
              if (!needsKeyExtraction(db, sessionId, accountDir)) {
                // All keys valid - skip extraction
                console.log(`[login] Key check took ${Date.now() - keyCheckStart}ms — skipping extraction`);
                planState.phase = "done";
                return {
                  action: {
                    type: "sequence",
                    actions: [
                      {
                        type: "emit",
                        event: { type: "login_success", userId: accountDir },
                      },
                      CommonActions.WAIT_SHORT,
                    ],
                  },
                  metadata: mainMeta,
                };
              }

              // Keys missing or invalid - extract
              planState.phase = "extracting_keys";
              return {
                action: {
                  type: "sequence",
                  actions: [
                    {
                      type: "emit",
                      event: { type: "status", message: "Getting your WeChat messages..." },
                    },
                    CommonActions.WAIT_SHORT,
                  ],
                },
                metadata: mainMeta,
              };
          }

          // Detection failed - retry up to 10 times (WeChat may still be starting)
          planState.detectRetries++;
          if (planState.detectRetries >= 10) {
            // Give up on detection, emit success without keys
            planState.phase = "done";
            return {
              action: {
                type: "sequence",
                actions: [
                  {
                    type: "emit",
                    event: { type: "login_success" },
                  },
                  CommonActions.WAIT_SHORT,
                ],
              },
              metadata: mainMeta,
            };
          }
          return { action: { type: "wait", ms: 2000 }, metadata: mainMeta };
        }

        // Phase: extracting_keys -> run setup (~20s)
        if (planState.phase === "extracting_keys") {
          const sessionRow2 = db.select({ wechatPid: sessions.wechatPid })
            .from(sessions).where(eq(sessions.id, sessionId)).get();
          const wechatPid = sessionRow2?.wechatPid ?? findWechatPid();

          if (wechatPid && planState.accountDir) {
            try {
              const keys = extractKeys(wechatPid);
              storeKeys(db, sessionId, planState.accountDir, keys);
            } catch (error) {
              console.error("[login] Key extraction failed:", error);
              // Continue anyway - keys can be extracted later
            }
          }

          planState.phase = "done";
          return {
            action: {
              type: "sequence",
              actions: [
                {
                  type: "emit",
                  event: {
                    type: "login_success",
                    userId: planState.accountDir,
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
