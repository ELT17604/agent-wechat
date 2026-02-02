import type { IAState } from "../types.js";
import { querySelector } from "../selectors.js";

/**
 * Error popup state - WeChat shows an error dialog.
 */
export const popupErrorState: IAState = {
  fsm: "popup",
  id: "popup_error",

  identify: ({ a11y }) => {
    // Look for OK button AND error-related text
    const okBtn = querySelector(a11y, 'push-button[name="OK"]');
    const errorText = querySelector(a11y, 'static[name=/error|failed|timeout|失败|错误/i]');
    return okBtn !== null && errorText !== null;
  },

  reduce: ({ prev, a11y }) => {
    const errorText = querySelector(a11y, 'static[name=/error|failed|timeout|失败|错误/i]');
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
 * Confirm popup state - WeChat shows a confirmation dialog.
 */
export const popupConfirmState: IAState = {
  fsm: "popup",
  id: "popup_confirm",

  identify: ({ a11y }) => {
    // Look for OK/Confirm button but NOT error text
    const okBtn = querySelector(a11y, 'push-button[name=/OK|Confirm|确定|确认/i]');
    const isError = querySelector(a11y, 'static[name=/error|failed|timeout|失败|错误/i]') !== null;
    return okBtn !== null && !isError;
  },

  reduce: ({ prev, a11y }) => {
    // Try to get the message from any static text
    const messageEl = querySelector(a11y, 'static[name=/.+/]');
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
export const popupInfoState: IAState = {
  fsm: "popup",
  id: "popup_info",

  identify: ({ a11y }) => {
    // Generic popup with just an OK button
    const okBtn = querySelector(a11y, 'push-button[name=/OK|确定/i]');
    const isError = querySelector(a11y, 'static[name=/error|failed|timeout|失败|错误/i]') !== null;
    const isConfirm = querySelector(a11y, 'push-button[name=/Cancel|取消/i]') !== null;
    return okBtn !== null && !isError && !isConfirm;
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

export const popupStates: IAState[] = [
  popupErrorState,
  popupConfirmState,
  // popupInfoState is intentionally omitted to avoid false positives
  // It overlaps with popupConfirmState too much
];
