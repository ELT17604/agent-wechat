import type { A11yNode, IAState, InformationArchitecture, IdentifyArgs } from "./types.js";
import { loginStates } from "./states/login.js";
import { chatStates } from "./states/chat.js";
import { popupStates } from "./states/popup.js";
import { actions } from "./actions.js";

// Re-export types and utilities
export * from "./types.js";
export * from "./selectors.js";
export * from "./helpers.js";
export { actions } from "./actions.js";

/**
 * The Information Architecture - all UI states and actions.
 */
export const ia: InformationArchitecture = {
  states: [
    // Main window states (order matters - first match wins)
    ...chatStates, // Check for logged-in state first
    ...loginStates, // Then login states
    // Popup states
    ...popupStates,
  ],
  actions,
};

/**
 * Identify current states from a11y tree and screenshot.
 *
 * Returns the identified states for both FSMs (mainWindow and popup).
 * Popup can overlay mainWindow.
 */
export function identifyStates(
  a11yTree: A11yNode,
  screenshot: string
): {
  mainWindow: IAState | null;
  popup: IAState | null;
} {
  let mainWindow: IAState | null = null;
  let popup: IAState | null = null;

  const args: IdentifyArgs = { a11y: a11yTree, screenshot };

  for (const state of ia.states) {
    try {
      if (state.identify(args)) {
        if (state.fsm === "mainWindow" && !mainWindow) {
          mainWindow = state;
        } else if (state.fsm === "popup" && !popup) {
          popup = state;
        }
      }
    } catch {
      // Ignore errors in identify - state just won't match
    }

    // Stop if we found both
    if (mainWindow && popup) break;
  }

  return { mainWindow, popup };
}
