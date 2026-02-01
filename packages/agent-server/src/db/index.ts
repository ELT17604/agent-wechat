import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import path from "path";
import * as schema from "./schema.js";

// Export the Drizzle instance type for use in context
export type DatabaseInstance = BetterSQLite3Database<typeof schema>;

// Re-export schema for convenience
export * from "./schema.js";

let db: DatabaseInstance | null = null;
let sqliteDb: Database.Database | null = null;

export function initDb(): DatabaseInstance {
  const dbPath = process.env.AGENT_DB_PATH || "/data/agent.db";

  // Ensure directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  sqliteDb = new Database(dbPath);
  sqliteDb.pragma("journal_mode = WAL");

  // Create Drizzle instance with schema
  db = drizzle(sqliteDb, { schema });

  // Create tables if they don't exist
  // Drizzle doesn't auto-create tables, so we use raw SQL for initial setup
  sqliteDb.exec(`
    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      linux_user TEXT NOT NULL UNIQUE,
      display TEXT NOT NULL UNIQUE,
      dbus_address TEXT,
      vnc_port INTEGER UNIQUE,
      status TEXT NOT NULL DEFAULT 'stopped',
      login_state TEXT NOT NULL DEFAULT 'logged_out',
      wechat_pid INTEGER,
      xvfb_pid INTEGER,
      dbus_pid INTEGER,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);

    -- Chats table
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      name TEXT NOT NULL,
      avatar_description TEXT,
      last_message_preview TEXT,
      last_message_sender TEXT,
      last_activity_at TEXT,
      unread_count INTEGER DEFAULT 0,
      is_group INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      search_terms TEXT,
      scroll_position_hint INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chats_name ON chats(name);
    CREATE INDEX IF NOT EXISTS idx_chats_session ON chats(session_id);

    -- Messages table
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      chat_id TEXT NOT NULL REFERENCES chats(id),
      content_type TEXT NOT NULL,
      content_text TEXT,
      sender_name TEXT,
      is_outgoing INTEGER DEFAULT 0,
      timestamp_display TEXT,
      timestamp_parsed TEXT,
      adjacent_text_before TEXT,
      adjacent_text_after TEXT,
      is_downloaded INTEGER DEFAULT 0,
      download_path TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(chat_id, timestamp_parsed);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    -- Sync state table
    CREATE TABLE IF NOT EXISTS sync_state (
      session_id TEXT REFERENCES sessions(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, key)
    );
  `);

  return db;
}

export function getDb(): DatabaseInstance {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function closeDb(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    db = null;
  }
}
