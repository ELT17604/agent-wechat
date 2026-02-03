import type { ActionTemplate, A11yNode, Bounds } from "../types.js";
import { querySelector } from "../selectors.js";

/**
 * Base window control commands available in all main window states.
 * These commands target the window control toolbar buttons.
 */
export const windowControlCommands: Record<string, ActionTemplate> = {
  maximize: { type: "click", selector: 'tool-bar push-button[name="Maximize"]' },
  minimize: { type: "click", selector: 'tool-bar push-button[name="Minimize"]' },
  close: { type: "click", selector: 'tool-bar push-button[name="Disable"]' },
  sticky: { type: "click", selector: 'tool-bar push-button[name="Sticky"]' },
};

/**
 * Common wait command.
 */
export const waitCommand: ActionTemplate = { type: "wait", ms: 1000 };

/**
 * Window control button bounds extracted from frame.
 */
export interface WindowControlBounds {
  closeButtonBounds?: Bounds;
  minimizeButtonBounds?: Bounds;
  maximizeButtonBounds?: Bounds;
}

/**
 * Extract window control button bounds from a frame.
 * Returns bounds for close, minimize, and maximize buttons if found.
 */
export function extractWindowControlBounds(frame: A11yNode | undefined): WindowControlBounds {
  if (!frame) return {};

  const closeBtn = querySelector(frame, 'tool-bar push-button[name="Disable"]');
  const minimizeBtn = querySelector(frame, 'tool-bar push-button[name="Minimize"]');
  const maximizeBtn = querySelector(frame, 'tool-bar push-button[name="Maximize"]');

  return {
    closeButtonBounds: closeBtn?.bounds,
    minimizeButtonBounds: minimizeBtn?.bounds,
    maximizeButtonBounds: maximizeBtn?.bounds,
  };
}
