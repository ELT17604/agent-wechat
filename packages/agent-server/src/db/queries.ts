import { eq, desc, like, gt, and, sql, isNull } from "drizzle-orm";
import type { Chat, Message, MessageContentType } from "@thisnick/agent-wechat-shared";
import { randomUUID } from "crypto";
import type { DatabaseInstance } from "./index.js";
import { chats, messages, syncState, sessions } from "./schema.js";

// ============================================
// CHAT QUERIES
// ============================================

function dbChatToChat(row: typeof chats.$inferSelect): Chat {
  return {
    id: row.id,
    name: row.name,
    imageHash: row.imageHash ?? undefined,
    avatarDescription: row.avatarDescription ?? undefined,
    lastMessagePreview: row.lastMessagePreview ?? undefined,
    lastMessageSender: row.lastMessageSender ?? undefined,
    lastActivityAt: row.lastActivityAt ?? undefined,
    unreadCount: row.unreadCount ?? 0,
    isGroup: row.isGroup ?? false,
    isPinned: row.isPinned ?? false,
    isMuted: row.isMuted ?? false,
    searchTerms: row.searchTerms ? JSON.parse(row.searchTerms) : undefined,
    scrollPositionHint: row.scrollPositionHint ?? undefined,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
  };
}

export function getChatsFromDb(
  db: DatabaseInstance,
  limit: number = 50,
  unreadOnly: boolean = false
): Chat[] {
  const query = unreadOnly
    ? db.select().from(chats).where(gt(chats.unreadCount, 0)).orderBy(desc(chats.lastActivityAt)).limit(limit)
    : db.select().from(chats).orderBy(desc(chats.lastActivityAt)).limit(limit);

  const rows = query.all();
  return rows.map(dbChatToChat);
}

export function getChatFromDb(
  db: DatabaseInstance,
  id: string
): Chat | null {
  const row = db.select().from(chats).where(eq(chats.id, id)).get();
  return row ? dbChatToChat(row) : null;
}

export function findChatsByName(
  db: DatabaseInstance,
  name: string
): Chat[] {
  const rows = db
    .select()
    .from(chats)
    .where(like(chats.name, `%${name}%`))
    .orderBy(desc(chats.lastActivityAt))
    .limit(10)
    .all();

  return rows.map(dbChatToChat);
}

export function findChatByImageHash(
  db: DatabaseInstance,
  imageHash: string
): Chat | null {
  const row = db
    .select()
    .from(chats)
    .where(eq(chats.imageHash, imageHash))
    .get();

  return row ? dbChatToChat(row) : null;
}

export function findChatsByExactName(
  db: DatabaseInstance,
  name: string
): Chat[] {
  const rows = db
    .select()
    .from(chats)
    .where(eq(chats.name, name))
    .all();

  return rows.map(dbChatToChat);
}

export function upsertChat(
  db: DatabaseInstance,
  chat: Partial<Chat> & { name: string },
  sessionId?: string
): Chat {
  const id = chat.id || randomUUID();
  const now = new Date().toISOString();

  db.insert(chats)
    .values({
      id,
      sessionId: sessionId ?? null,
      name: chat.name,
      imageHash: chat.imageHash ?? null,
      avatarDescription: chat.avatarDescription ?? null,
      lastMessagePreview: chat.lastMessagePreview ?? null,
      lastMessageSender: chat.lastMessageSender ?? null,
      lastActivityAt: chat.lastActivityAt ?? null,
      unreadCount: chat.unreadCount ?? 0,
      isGroup: chat.isGroup ?? false,
      isPinned: chat.isPinned ?? false,
      isMuted: chat.isMuted ?? false,
      searchTerms: chat.searchTerms ? JSON.stringify(chat.searchTerms) : null,
      scrollPositionHint: chat.scrollPositionHint ?? null,
      createdAt: chat.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: chats.id,
      set: {
        name: chat.name,
        imageHash: chat.imageHash !== undefined ? chat.imageHash : sql`${chats.imageHash}`,
        avatarDescription: chat.avatarDescription !== undefined ? chat.avatarDescription : sql`${chats.avatarDescription}`,
        lastMessagePreview: chat.lastMessagePreview !== undefined ? chat.lastMessagePreview : sql`${chats.lastMessagePreview}`,
        lastMessageSender: chat.lastMessageSender !== undefined ? chat.lastMessageSender : sql`${chats.lastMessageSender}`,
        lastActivityAt: chat.lastActivityAt !== undefined ? chat.lastActivityAt : sql`${chats.lastActivityAt}`,
        unreadCount: chat.unreadCount ?? 0,
        // Only update isGroup if explicitly provided (don't downgrade from true to false)
        isGroup: chat.isGroup !== undefined ? chat.isGroup : sql`${chats.isGroup}`,
        isPinned: chat.isPinned ?? false,
        isMuted: chat.isMuted ?? false,
        searchTerms: chat.searchTerms !== undefined ? JSON.stringify(chat.searchTerms) : sql`${chats.searchTerms}`,
        scrollPositionHint: chat.scrollPositionHint !== undefined ? chat.scrollPositionHint : sql`${chats.scrollPositionHint}`,
        updatedAt: now,
      },
    })
    .run();

  return getChatFromDb(db, id)!;
}

// ============================================
// MESSAGE QUERIES
// ============================================

function dbMessageToMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    chatId: row.chatId,
    contentType: row.contentType as MessageContentType,
    contentText: row.contentText ?? undefined,
    senderName: row.senderName ?? undefined,
    isOutgoing: row.isOutgoing ?? false,
    timestampDisplay: row.timestampDisplay ?? undefined,
    timestampParsed: row.timestampParsed ?? undefined,
    adjacentTextBefore: row.adjacentTextBefore ?? undefined,
    adjacentTextAfter: row.adjacentTextAfter ?? undefined,
    isDownloaded: row.isDownloaded ?? false,
    downloadPath: row.downloadPath ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
  };
}

export function getMessagesFromDb(
  db: DatabaseInstance,
  chatId: string,
  limit: number = 50,
  since?: string
): Message[] {
  const conditions = since
    ? and(eq(messages.chatId, chatId), gt(messages.timestampParsed, since))
    : eq(messages.chatId, chatId);

  const rows = db
    .select()
    .from(messages)
    .where(conditions)
    .orderBy(desc(messages.timestampParsed))
    .limit(limit)
    .all();

  return rows.map(dbMessageToMessage);
}

export function getMessageFromDb(
  db: DatabaseInstance,
  id: string
): Message | null {
  const row = db.select().from(messages).where(eq(messages.id, id)).get();
  return row ? dbMessageToMessage(row) : null;
}

export function upsertMessage(
  db: DatabaseInstance,
  message: Partial<Message> & { chatId: string; contentType: MessageContentType }
): Message {
  const id = message.id || randomUUID();
  const now = new Date().toISOString();

  db.insert(messages)
    .values({
      id,
      chatId: message.chatId,
      contentType: message.contentType,
      contentText: message.contentText ?? null,
      senderName: message.senderName ?? null,
      isOutgoing: message.isOutgoing ?? false,
      timestampDisplay: message.timestampDisplay ?? null,
      timestampParsed: message.timestampParsed ?? null,
      adjacentTextBefore: message.adjacentTextBefore ?? null,
      adjacentTextAfter: message.adjacentTextAfter ?? null,
      isDownloaded: message.isDownloaded ?? false,
      downloadPath: message.downloadPath ?? null,
      metadata: message.metadata ? JSON.stringify(message.metadata) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        contentType: message.contentType,
        contentText: message.contentText !== undefined ? message.contentText : sql`${messages.contentText}`,
        senderName: message.senderName !== undefined ? message.senderName : sql`${messages.senderName}`,
        isOutgoing: message.isOutgoing ?? false,
        timestampDisplay: message.timestampDisplay !== undefined ? message.timestampDisplay : sql`${messages.timestampDisplay}`,
        timestampParsed: message.timestampParsed !== undefined ? message.timestampParsed : sql`${messages.timestampParsed}`,
        adjacentTextBefore: message.adjacentTextBefore !== undefined ? message.adjacentTextBefore : sql`${messages.adjacentTextBefore}`,
        adjacentTextAfter: message.adjacentTextAfter !== undefined ? message.adjacentTextAfter : sql`${messages.adjacentTextAfter}`,
        isDownloaded: message.isDownloaded ?? false,
        downloadPath: message.downloadPath !== undefined ? message.downloadPath : sql`${messages.downloadPath}`,
        metadata: message.metadata !== undefined ? JSON.stringify(message.metadata) : sql`${messages.metadata}`,
        updatedAt: now,
      },
    })
    .run();

  return getMessageFromDb(db, id)!;
}

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

export function clearSessionChatData(
  db: DatabaseInstance,
  sessionId: string
): void {
  // Messages cascade-deleted via FK when chats are deleted
  db.delete(chats).where(eq(chats.sessionId, sessionId)).run();
  db.delete(syncState).where(eq(syncState.sessionId, sessionId)).run();
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
