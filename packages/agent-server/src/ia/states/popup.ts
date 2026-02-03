import type { IAState, FrameIdentifyMetadata } from "../types.js";
import { querySelector, findAncestor } from "../selectors.js";

/**
 * Error popup state - WeChat shows an error dialog.
 */
export const popupErrorState: IAState<FrameIdentifyMetadata> = {
  fsm: "popup",
  id: "popup_error",

  identify: ({ a11y }) => {
    // Look for OK button AND error-related text (in static or label)
    const okBtn = querySelector(a11y, 'push-button[name="OK"]');
    const errorText = querySelector(a11y, 'static[name=/error|failed|timeout|失败|错误/i]') ??
                      querySelector(a11y, 'label[name=/error|failed|timeout|失败|错误/i]');

    if (!okBtn || !errorText) return { identified: false };

    // Find the containing frame or filler (dialog container)
    const frame = findAncestor(okBtn, "frame") ?? findAncestor(okBtn, "filler");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: ({ prev, a11y }) => {
    const errorText = querySelector(a11y, 'static[name=/error|failed|timeout|失败|错误/i]') ??
                      querySelector(a11y, 'label[name=/error|failed|timeout|失败|错误/i]');
    return {
      ...prev,
      popup: {
        type: "error",
        message: errorText?.name,
      },
    };
  },

  commands: {
    dismiss_popup: { type: "click", selector: 'push-button[name="OK"]' },
  },
};

/**
 * Confirm/Tip popup state - WeChat shows a confirmation or tip dialog.
 * Matches popups with OK button that aren't error dialogs.
 */
export const popupConfirmState: IAState<FrameIdentifyMetadata> = {
  fsm: "popup",
  id: "popup_confirm",

  identify: ({ a11y }) => {
    // Look for OK/Confirm button but NOT error text
    const okBtn = querySelector(a11y, 'push-button[name=/OK|Confirm|确定|确认/i]');
    if (!okBtn) return { identified: false };

    // Check for error text in both static and label elements
    const errorInStatic = querySelector(a11y, 'static[name=/error|failed|timeout|失败|错误/i]') !== null;
    const errorInLabel = querySelector(a11y, 'label[name=/error|failed|timeout|失败|错误/i]') !== null;
    if (errorInStatic || errorInLabel) return { identified: false };

    // Find the containing frame or filler (dialog container)
    const frame = findAncestor(okBtn, "frame") ?? findAncestor(okBtn, "filler");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: ({ prev, a11y }) => {
    // Try to get the message from static or label text (skip "Tip" header)
    const messageEl = querySelector(a11y, 'static[name=/.+/]') ??
                      querySelector(a11y, 'label[name=/^(?!Tip$).+/]');
    return {
      ...prev,
      popup: {
        type: "confirm",
        message: messageEl?.name,
      },
    };
  },

  commands: {
    dismiss_popup: { type: "click", selector: 'push-button[name=/OK|Confirm|确定|确认/i]' },
    cancel_popup: { type: "click", selector: 'push-button[name=/Cancel|取消/i]' },
  },
};

/**
 * Info popup state - WeChat shows an info dialog.
 */
export const popupInfoState: IAState<FrameIdentifyMetadata> = {
  fsm: "popup",
  id: "popup_info",

  identify: ({ a11y }) => {
    // Generic popup with just an OK button
    const okBtn = querySelector(a11y, 'push-button[name=/OK|确定/i]');
    const isError = querySelector(a11y, 'static[name=/error|failed|timeout|失败|错误/i]') !== null;
    const isConfirm = querySelector(a11y, 'push-button[name=/Cancel|取消/i]') !== null;

    if (!okBtn || isError || isConfirm) return { identified: false };

    // Find the containing frame (dialog)
    const frame = findAncestor(okBtn, "frame");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: ({ prev, a11y }) => {
    const messageEl = querySelector(a11y, 'static[name=/.+/]');
    return {
      ...prev,
      popup: {
        type: "info",
        message: messageEl?.name,
      },
    };
  },

  commands: {
    dismiss_popup: { type: "click", selector: 'push-button[name=/OK|确定/i]' },
  },
};

export const popupStates: IAState<FrameIdentifyMetadata>[] = [
  popupErrorState,
  popupConfirmState,
  // popupInfoState is intentionally omitted to avoid false positives
  // It overlaps with popupConfirmState too much
];
