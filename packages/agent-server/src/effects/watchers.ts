import type { DatabaseInstance } from "../db/index.js";
import type { AppState, Effect, EffectWatcher } from "../ia/types.js";

/**
 * Global effect watchers.
 *
 * These are reactive functions that run after every state transition.
 * They only produce effects when state actually changes.
 *
 * Note: All login emissions (QR, phone_confirm, login_success) are now
 * handled by the login plan to ensure proper sequencing (maximize,
 * extract user ID from contact card, then signal success).
 */
export const effectWatchers: EffectWatcher[] = [];

/**
 * Collect effects from all watchers.
 */
export function collectEffects(prev: AppState, next: AppState, db: DatabaseInstance): Effect[] {
  return effectWatchers.flatMap((w) => w({ prev, next, db }));
}
