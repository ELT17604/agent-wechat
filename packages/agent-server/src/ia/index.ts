import type { A11yNode, IAState, IdentifyArgs } from "./types.js";
import { loginStates } from "./states/login.js";
import { chatStates } from "./states/chat.js";
import { popupStates } from "./states/popup.js";

// Re-export types and utilities
export * from "./types.js";
export * from "./selectors.js";
export * from "./helpers.js";

/**
 * All UI states (order matters - first match wins).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const allStates: IAState<any>[] = [
  // Main window states
  ...chatStates, // Check for logged-in state first
  ...loginStates, // Then login states
  // Popup states
  ...popupStates,
];

/**
 * Result from identifyStates, including metadata from identify functions.
 */
export interface IdentifiedStates {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow: IAState<any> | null;
  mainWindowMetadata?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  popup: IAState<any> | null;
  popupMetadata?: unknown;
}

/**
 * Identify current states from a11y tree and screenshot.
 *
 * Returns the identified states for both FSMs (mainWindow and popup),
 * along with any metadata from the identify functions.
 * Popup can overlay mainWindow.
 */
export function identifyStates(
  a11yTree: A11yNode,
  screenshot: string
): IdentifiedStates {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mainWindow: IAState<any> | null = null;
  let mainWindowMetadata: unknown = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let popup: IAState<any> | null = null;
  let popupMetadata: unknown = undefined;

  const args: IdentifyArgs = { a11y: a11yTree, screenshot };

  for (const state of allStates) {
    try {
      const result = state.identify(args);
      if (result.identified) {
        if (state.fsm === "mainWindow" && !mainWindow) {
          mainWindow = state;
          mainWindowMetadata = result.metadata;
        } else if (state.fsm === "popup" && !popup) {
          popup = state;
          popupMetadata = result.metadata;
        }
      }
    } catch {
      // Ignore errors in identify - state just won't match
    }

    // Stop if we found both
    if (mainWindow && popup) break;
  }

  return { mainWindow, mainWindowMetadata, popup, popupMetadata };
}
