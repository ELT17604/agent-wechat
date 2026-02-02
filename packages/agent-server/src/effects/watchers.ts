import type { AppState, Effect, EffectWatcher } from "../ia/types.js";

/**
 * Global effect watchers.
 *
 * These are reactive functions that run after every state transition.
 * They only produce effects when state actually changes.
 */
export const effectWatchers: EffectWatcher[] = [
  // QR code changed → emit to client
  ({ prev, next }) =>
    next.mainWindow.qrData &&
    next.mainWindow.qrData !== prev.mainWindow.qrData
      ? [{ type: "emit", event: {
          type: "qr",
          qrData: next.mainWindow.qrData,
          qrBinaryData: next.mainWindow.qrBinaryData,
        } }]
      : [],

  // Entered phone_confirm → emit once
  ({ prev, next }) =>
    next.mainWindow.view === "login_phone_confirm" &&
    prev.mainWindow.view !== "login_phone_confirm"
      ? [{ type: "emit", event: { type: "phone_confirm", message: "Please confirm login on your phone" } }]
      : [],

  // Reached chat from login → emit success
  ({ prev, next }) =>
    next.mainWindow.view === "chat" &&
    prev.mainWindow.view !== "chat" &&
    prev.mainWindow.view.startsWith("login")
      ? [{ type: "emit", event: { type: "login_success" } }]
      : [],
];

/**
 * Collect effects from all watchers.
 */
export function collectEffects(prev: AppState, next: AppState): Effect[] {
  return effectWatchers.flatMap((w) => w({ prev, next }));
}
