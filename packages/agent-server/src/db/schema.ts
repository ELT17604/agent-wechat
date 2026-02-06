import { sqliteTable, text, integer, primaryKey, index, unique } from "drizzle-orm/sqlite-core";

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
  loggedInUser: text("logged_in_user"),  // WeChat account dir (e.g. "wxid_xxx_abc123")
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
// WECHAT KEYS (per-session, per-account encryption keys)
// ============================================
export const wechatKeys = sqliteTable("wechat_keys", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  accountDir: text("account_dir").notNull(),  // e.g. "wxid_xxx_abc123"
  dbName: text("db_name").notNull(),          // e.g. "session.db", "contact.db"
  hexKey: text("hex_key").notNull(),          // 64-char hex AES-256 key
  verifiedAt: text("verified_at"),
}, (table) => [
  unique("uq_wechat_keys").on(table.sessionId, table.accountDir, table.dbName),
  index("idx_wechat_keys_session_account").on(table.sessionId, table.accountDir),
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
export type WechatKey = typeof wechatKeys.$inferSelect;
export type NewWechatKey = typeof wechatKeys.$inferInsert;
export type SyncState = typeof syncState.$inferSelect;
export type NewSyncState = typeof syncState.$inferInsert;
export type Context = typeof context.$inferSelect;
export type NewContext = typeof context.$inferInsert;
