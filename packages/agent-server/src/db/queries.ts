import { eq, and, isNull } from "drizzle-orm";
import type { DatabaseInstance } from "./index.js";
import { syncState, sessions, wechatKeys } from "./schema.js";

// ============================================
// SYNC STATE QUERIES
// ============================================

export function getSyncState(db: DatabaseInstance, key: string, sessionId?: string | null): string | null {
  const row = sessionId
    ? db.select().from(syncState).where(and(eq(syncState.key, key), eq(syncState.sessionId, sessionId))).get()
    : db.select().from(syncState).where(and(eq(syncState.key, key), isNull(syncState.sessionId))).get();

  return row?.value ?? null;
}

export function setSyncState(db: DatabaseInstance, key: string, value: string, sessionId?: string | null): void {
  const now = new Date().toISOString();

  db.insert(syncState)
    .values({
      sessionId: sessionId ?? null,
      key,
      value,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [syncState.sessionId, syncState.key],
      set: {
        value,
        updatedAt: now,
      },
    })
    .run();
}

// ============================================
// SESSION QUERIES
// ============================================

export function getSessionLoggedInUser(
  db: DatabaseInstance,
  sessionId: string
): string | null {
  const row = db.select({ loggedInUser: sessions.loggedInUser })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  return row?.loggedInUser ?? null;
}

export function updateSessionLoggedInUser(
  db: DatabaseInstance,
  sessionId: string,
  loggedInUser: string | null
): void {
  db.update(sessions)
    .set({ loggedInUser, updatedAt: new Date().toISOString() })
    .where(eq(sessions.id, sessionId))
    .run();
}

export function clearSessionLoggedInUser(
  db: DatabaseInstance,
  sessionId: string
): void {
  updateSessionLoggedInUser(db, sessionId, null);
}

/**
 * Clear all session-scoped data (keys, sync state).
 * Used on account switch.
 */
export function clearSessionData(
  db: DatabaseInstance,
  sessionId: string
): void {
  db.delete(wechatKeys).where(eq(wechatKeys.sessionId, sessionId)).run();
  db.delete(syncState).where(eq(syncState.sessionId, sessionId)).run();
}
