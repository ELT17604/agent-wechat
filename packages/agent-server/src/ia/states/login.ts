import type { IAState } from "../types.js";
import { querySelector } from "../selectors.js";
import { decodeQrFromBase64Sync, decodeQrFullSync } from "../../lib/qr.js";

/**
 * Login QR state - WeChat shows a QR code to scan.
 * Identified by: "Scan to log in" label + "Transfer files only" button + WeChat QR code in screenshot.
 */
export const loginQrState: IAState = {
  fsm: "mainWindow",
  id: "login_qr",

  identify: ({ a11y, screenshot }) => {
    // Must have all three indicators:
    // 1. "Scan to log in" label
    const hasScanToLogin = querySelector(a11y, 'label[name*="Scan to log in"]') !== null;
    // 2. "Transfer files only" button
    const hasTransferFiles = querySelector(a11y, 'push-button[name*="Transfer files only"]') !== null;
    // 3. WeChat QR code detected in screenshot (starts with http://weixin.qq.com/x/)
    const qrData = decodeQrFromBase64Sync(screenshot);
    const hasWeChatQr = qrData !== null && qrData.startsWith("http://weixin.qq.com/x/");

    return hasScanToLogin && hasTransferFiles && hasWeChatQr;
  },

  reduce: ({ prev, screenshot }) => {
    // Extract QR data from screenshot (screenshot is Buffer, convert to base64)
    const qrResult = decodeQrFullSync(screenshot.toString("base64"));
    return {
      ...prev,
      mainWindow: {
        view: "login_qr",
        qrData: qrResult?.data ?? prev.mainWindow.qrData,
        qrBinaryData: qrResult?.binaryData ?? prev.mainWindow.qrBinaryData,
      },
    };
  },

  commands: {
    wait: { type: "wait", ms: 1000 },
  },
};

/**
 * Login account state - WeChat shows a saved account to confirm.
 * Identified by: "Log In" button + "Switch Account" button + "Transfer files only" button
 */
export const loginAccountState: IAState = {
  fsm: "mainWindow",
  id: "login_account",

  identify: ({ a11y }) => {
    // Must have all three buttons
    const hasLogIn = querySelector(a11y, 'push-button[name="Log In"]') !== null;
    const hasSwitchAccount = querySelector(a11y, 'push-button[name="Switch Account"]') !== null;
    const hasTransferFiles = querySelector(a11y, 'push-button[name="Transfer files only"]') !== null;
    return hasLogIn && hasSwitchAccount && hasTransferFiles;
  },

  reduce: ({ prev, a11y }) => {
    // Try to extract the account name from a label (e.g., "Current UserNick Bot")
    const nameEl = querySelector(a11y, 'label[name*="Current User"]');
    return {
      ...prev,
      mainWindow: {
        view: "login_account",
        accountName: nameEl?.name?.replace("Current User", "").trim(),
      },
    };
  },

  commands: {
    click_login: { type: "click", selector: 'push-button[name="Log In"]' },
    click_switch_account: { type: "click", selector: 'push-button[name="Switch Account"]' },
  },
};

/**
 * Login phone confirm state - user needs to confirm on phone.
 * Note: WeChat has a typo "Comfirm" instead of "Confirm"
 */
export const loginPhoneConfirmState: IAState = {
  fsm: "mainWindow",
  id: "login_phone_confirm",

  identify: ({ a11y }) => {
    // Look for phone confirmation text (label, not static)
    // Note: WeChat has typo "Comfirm on phone"
    return querySelector(a11y, 'label[name=/Comfirm on phone|Confirm.*phone|手机确认/i]') !== null;
  },

  reduce: ({ prev }) => ({
    ...prev,
    mainWindow: {
      view: "login_phone_confirm",
    },
  }),

  commands: {
    wait: { type: "wait", ms: 1000 },
  },
};

/**
 * Login loading state - transitional state while logging in.
 * Includes:
 * - "Entering" or "Loading X%" screens
 * - Main window with nav buttons but Chats list not yet loaded
 */
export const loginLoadingState: IAState = {
  fsm: "mainWindow",
  id: "login_loading",

  identify: ({ a11y }) => {
    // Case 1: "Entering" or "Loading X%" labels
    const hasEntering = querySelector(a11y, 'label[name="Entering"]') !== null;
    const hasLoading = querySelector(a11y, 'label[name*="Loading"]') !== null;
    if (hasEntering || hasLoading) {
      return true;
    }

    // Case 2: Nav buttons present but Chats list not yet loaded
    const hasMainButton = querySelector(a11y, 'push-button[name="Weixin"]') !== null ||
                          querySelector(a11y, 'push-button[name="WeChat"]') !== null;
    const hasContactsButton = querySelector(a11y, 'push-button[name="Contacts"]') !== null;
    const hasChatsList = querySelector(a11y, 'list[name="Chats"]') !== null;

    // Has nav buttons but no Chats list = still loading
    return hasMainButton && hasContactsButton && !hasChatsList;
  },

  reduce: ({ prev }) => ({
    ...prev,
    mainWindow: {
      view: "login_loading" as const,
    },
  }),

  commands: {
    wait: { type: "wait", ms: 500 },
  },
};

export const loginStates: IAState[] = [
  loginQrState,
  loginAccountState,
  loginPhoneConfirmState,
  loginLoadingState,
];
