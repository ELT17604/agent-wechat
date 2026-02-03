import { z } from "zod";
import type { Plan, ActionParams, AppState } from "../ia/types.js";
import type Database from "better-sqlite3";

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
 * Login Plan
 *
 * Navigates the WeChat login flow from any state to logged-in state.
 *
 * States handled:
 * - login_qr: Wait for QR code scan
 * - login_account: Click "Log In" or "Switch Account"
 * - login_phone_confirm: Wait for phone confirmation (notify client)
 * - login_loading: Wait for app to load
 * - chat: Already logged in (goal reached)
 * - popup: Dismiss any popup dialogs
 */
export const loginPlan: Plan<LoginParams> = {
  id: "login",
  description: "Log into WeChat",
  params: loginParamsSchema,

  isGoalReached: ({ state }: { state: AppState }) => {
    // Goal: chat view with no popup
    return state.mainWindow.view === "chat" && state.popup === null;
  },

  selectAction: ({
    state,
    params,
  }: {
    state: AppState;
    params: LoginParams;
    db: Database.Database;
  }) => {
    // Rule 1: Always dismiss popups first
    if (state.popup !== null) {
      return "dismiss_popup";
    }

    // Rule 2: Based on main window state
    switch (state.mainWindow.view) {
      case "login_qr":
        // Wait for QR code scan (effect watcher emits QR)
        return "wait";

      case "login_account":
        // Choose between existing account or new account
        return params.newAccount ? "click_switch_account" : "click_login";

      case "login_phone_confirm":
        // Wait for phone confirmation (effect watcher emits once on state entry)
        return "wait";

      case "login_loading":
        // Wait for app to load
        return "wait";

      case "chat":
        // Maximize window, then goal is reached
        return "maximize";

      default:
        // Unknown state
        return null;
    }
  },
};
