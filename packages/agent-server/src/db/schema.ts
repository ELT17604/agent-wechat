import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

// ============================================
// SESSIONS (multi-user support)
// ============================================
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  linuxUser: text("linux_user").notNull().unique(),
  display: text("display").notNull().unique(),
  dbusAddress: text("dbus_address"),
  vncPort: integer("vnc_port").unique(),
  status: text("status", { enum: ["stopped", "starting", "running", "stopping", "error"] }).notNull().default("stopped"),
  loginState: text("login_state").notNull().default("logged_out"),
  loggedInUser: text("logged_in_user"),  // WeChat ID of logged-in user
  wechatPid: integer("wechat_pid"),
  xvfbPid: integer("xvfb_pid"),
  dbusPid: integer("dbus_pid"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").default("(datetime('now'))"),
  updatedAt: text("updated_at").default("(datetime('now'))"),
}, (table) => [
  index("idx_sessions_status").on(table.status),
  index("idx_sessions_name").on(table.name),
]);

// ============================================
// CHATS (threads/conversations)
// ============================================
export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").references(() => sessions.id),
  name: text("name").notNull(),
  imageHash: text("image_hash"),  // MD5 hash of avatar for identity matching
  avatarDescription: text("avatar_description"),
  lastMessagePreview: text("last_message_preview"),
  lastMessageSender: text("last_message_sender"),
  lastActivityAt: text("last_activity_at"),
  unreadCount: integer("unread_count").default(0),
  isGroup: integer("is_group", { mode: "boolean" }).default(false),
  isPinned: integer("is_pinned", { mode: "boolean" }).default(false),
  isMuted: integer("is_muted", { mode: "boolean" }).default(false),
  searchTerms: text("search_terms"),
  scrollPositionHint: integer("scroll_position_hint"),
  createdAt: text("created_at").default("(datetime('now'))"),
  updatedAt: text("updated_at").default("(datetime('now'))"),
}, (table) => [
  index("idx_chats_name").on(table.name),
  index("idx_chats_session").on(table.sessionId),
  index("idx_chats_image_hash").on(table.imageHash),
]);

// ============================================
// MESSAGES
// ============================================
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").references(() => sessions.id),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  contentType: text("content_type").notNull(),
  contentText: text("content_text"),
  senderName: text("sender_name"),
  isOutgoing: integer("is_outgoing", { mode: "boolean" }).default(false),
  timestampDisplay: text("timestamp_display"),
  timestampParsed: text("timestamp_parsed"),
  adjacentTextBefore: text("adjacent_text_before"),
  adjacentTextAfter: text("adjacent_text_after"),
  isDownloaded: integer("is_downloaded", { mode: "boolean" }).default(false),
  downloadPath: text("download_path"),
  metadata: text("metadata"),
  createdAt: text("created_at").default("(datetime('now'))"),
  updatedAt: text("updated_at").default("(datetime('now'))"),
}, (table) => [
  index("idx_messages_chat").on(table.chatId),
  index("idx_messages_time").on(table.chatId, table.timestampParsed),
  index("idx_messages_session").on(table.sessionId),
]);

// ============================================
// SYNC STATE (session-scoped key-value)
// ============================================
export const syncState = sqliteTable("sync_state", {
  sessionId: text("session_id").references(() => sessions.id),
  key: text("key").notNull(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").default("(datetime('now'))"),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.key] }),
]);

// ============================================
// CONTEXT (FSM AppState persistence)
// ============================================
export const context = sqliteTable("context", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id),
  appState: text("app_state").notNull(), // JSON-encoded AppState
  updatedAt: text("updated_at").default("(datetime('now'))"),
});

// Type exports
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type SyncState = typeof syncState.$inferSelect;
export type NewSyncState = typeof syncState.$inferInsert;
export type Context = typeof context.$inferSelect;
export type NewContext = typeof context.$inferInsert;
