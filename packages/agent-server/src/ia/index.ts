import type { A11yNode, IAState, IdentifyArgs } from "./types.js";
import { loginStates } from "./states/login.js";
import { chatStates } from "./states/chat.js";
import { popupStates } from "./states/popup.js";
import { contactCardState, ContactCardActions } from "./states/contact-card.js";

// Re-export types and utilities
export * from "./types.js";
export * from "./selectors.js";
export * from "./helpers.js";
export { ContactCardActions };

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
  // Contact card (separate FSM)
  contactCardState,
];

/**
 * An identified state bundled with its metadata.
 */
export interface IdentifiedState<TMetadata = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: IAState<any>;
  metadata?: TMetadata;
}

/**
 * Result from identifyStates, including metadata from identify functions.
 */
export interface IdentifiedStates {
  mainWindow: IdentifiedState | null;
  popup: IdentifiedState | null;
  contactCard: IdentifiedState | null;
}

/**
 * Identify current states from a11y tree and screenshot.
 *
 * Returns the identified states for all FSMs (mainWindow, popup, contactCard),
 * along with any metadata from the identify functions.
 * Popup and contactCard can overlay mainWindow.
 */
export function identifyStates(
  a11yTree: A11yNode,
  screenshot: string
): IdentifiedStates {
  let mainWindow: IdentifiedState | null = null;
  let popup: IdentifiedState | null = null;
  let contactCard: IdentifiedState | null = null;

  const args: IdentifyArgs = { a11y: a11yTree, screenshot };

  for (const state of allStates) {
    try {
      const result = state.identify(args);
      if (result.identified) {
        if (state.fsm === "mainWindow" && !mainWindow) {
          mainWindow = { state, metadata: result.metadata };
        } else if (state.fsm === "popup" && !popup) {
          popup = { state, metadata: result.metadata };
        } else if (state.fsm === "contactCard" && !contactCard) {
          contactCard = { state, metadata: result.metadata };
        }
      }
    } catch {
      // Ignore errors in identify - state just won't match
    }

    // Stop if we found all three
    if (mainWindow && popup && contactCard) break;
  }

  return { mainWindow, popup, contactCard };
}
