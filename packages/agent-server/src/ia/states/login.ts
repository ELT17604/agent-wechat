import type { IAState, FrameIdentifyMetadata } from "../types.js";
import { querySelector, findAncestor } from "../selectors.js";
import { decodeQrFromBase64Sync, decodeQrFullSync } from "../../lib/qr.js";
import { windowControlCommands, extractWindowControlBounds } from "./base.js";

/**
 * Login QR state - WeChat shows a QR code to scan.
 * Identified by: "Scan to log in" label + "Transfer files only" button + WeChat QR code in screenshot.
 */
export const loginQrState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "login_qr",

  identify: ({ a11y, screenshot }) => {
    // Must have all three indicators:
    // 1. "Scan to log in" label
    const scanLabel = querySelector(a11y, 'label[name*="Scan to log in"]');
    if (!scanLabel) return { identified: false };

    // 2. "Transfer files only" button
    const hasTransferFiles = querySelector(a11y, 'push-button[name*="Transfer files only"]') !== null;
    if (!hasTransferFiles) return { identified: false };

    // 3. WeChat QR code detected in screenshot (starts with http://weixin.qq.com/x/)
    const qrData = decodeQrFromBase64Sync(screenshot);
    const hasWeChatQr = qrData !== null && qrData.startsWith("http://weixin.qq.com/x/");
    if (!hasWeChatQr) return { identified: false };

    // Find the containing frame
    const frame = findAncestor(scanLabel, "frame");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: ({ prev, screenshot, metadata }) => {
    const qrResult = decodeQrFullSync(screenshot.toString("base64"));
    const windowBounds = extractWindowControlBounds(metadata?.frame);

    return {
      ...prev,
      mainWindow: {
        view: "login_qr",
        qrData: qrResult?.data ?? prev.mainWindow.qrData,
        qrBinaryData: qrResult?.binaryData ?? prev.mainWindow.qrBinaryData,
        ...windowBounds,
      },
    };
  },

  commands: {
    wait: { type: "wait", ms: 1000 },
    ...windowControlCommands,
  },
};

/**
 * Login account state - WeChat shows a saved account to confirm.
 * Identified by: "Log In" button + "Switch Account" button + "Transfer files only" button
 */
export const loginAccountState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "login_account",

  identify: ({ a11y }) => {
    const logInBtn = querySelector(a11y, 'push-button[name="Log In"]');
    if (!logInBtn) return { identified: false };

    const hasSwitchAccount = querySelector(a11y, 'push-button[name="Switch Account"]') !== null;
    const hasTransferFiles = querySelector(a11y, 'push-button[name="Transfer files only"]') !== null;
    if (!hasSwitchAccount || !hasTransferFiles) return { identified: false };

    const frame = findAncestor(logInBtn, "frame");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: ({ prev, a11y, metadata }) => {
    const nameEl = querySelector(a11y, 'label[name*="Current User"]');
    const windowBounds = extractWindowControlBounds(metadata?.frame);

    return {
      ...prev,
      mainWindow: {
        view: "login_account",
        accountName: nameEl?.name?.replace("Current User", "").trim(),
        ...windowBounds,
      },
    };
  },

  commands: {
    click_login: { type: "click", selector: 'push-button[name="Log In"]' },
    click_switch_account: { type: "click", selector: 'push-button[name="Switch Account"]' },
    ...windowControlCommands,
  },
};

/**
 * Login phone confirm state - user needs to confirm on phone.
 * Note: WeChat has a typo "Comfirm" instead of "Confirm"
 */
export const loginPhoneConfirmState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "login_phone_confirm",

  identify: ({ a11y }) => {
    const confirmLabel = querySelector(a11y, 'label[name=/Comfirm on phone|Confirm.*phone|手机确认/i]');
    if (!confirmLabel) return { identified: false };

    const frame = findAncestor(confirmLabel, "frame");
    return { identified: true, metadata: frame ? { frame } : undefined };
  },

  reduce: ({ prev, metadata }) => {
    const windowBounds = extractWindowControlBounds(metadata?.frame);

    return {
      ...prev,
      mainWindow: {
        view: "login_phone_confirm",
        ...windowBounds,
      },
    };
  },

  commands: {
    wait: { type: "wait", ms: 1000 },
    ...windowControlCommands,
  },
};

/**
 * Login loading state - transitional state while logging in.
 * Includes:
 * - "Entering" or "Loading X%" screens
 * - Main window with nav buttons but Chats list not yet loaded
 */
export const loginLoadingState: IAState<FrameIdentifyMetadata> = {
  fsm: "mainWindow",
  id: "login_loading",

  identify: ({ a11y }) => {
    // Case 1: "Entering" or "Loading X%" labels
    const enteringLabel = querySelector(a11y, 'label[name="Entering"]');
    if (enteringLabel) {
      const frame = findAncestor(enteringLabel, "frame");
      return { identified: true, metadata: frame ? { frame } : undefined };
    }

    const loadingLabel = querySelector(a11y, 'label[name*="Loading"]');
    if (loadingLabel) {
      const frame = findAncestor(loadingLabel, "frame");
      return { identified: true, metadata: frame ? { frame } : undefined };
    }

    // Case 2: Nav buttons present but Chats list not yet loaded
    const mainButton = querySelector(a11y, 'push-button[name="Weixin"]') ??
                       querySelector(a11y, 'push-button[name="WeChat"]');
    const hasContactsButton = querySelector(a11y, 'push-button[name="Contacts"]') !== null;
    const hasChatsList = querySelector(a11y, 'list[name="Chats"]') !== null;

    if (mainButton && hasContactsButton && !hasChatsList) {
      const frame = findAncestor(mainButton, "frame");
      return { identified: true, metadata: frame ? { frame } : undefined };
    }

    return { identified: false };
  },

  reduce: ({ prev, metadata }) => {
    const windowBounds = extractWindowControlBounds(metadata?.frame);

    return {
      ...prev,
      mainWindow: {
        view: "login_loading" as const,
        ...windowBounds,
      },
    };
  },

  commands: {
    wait: { type: "wait", ms: 500 },
    ...windowControlCommands,
  },
};

export const loginStates: IAState<FrameIdentifyMetadata>[] = [
  loginQrState,
  loginAccountState,
  loginPhoneConfirmState,
  loginLoadingState,
];
