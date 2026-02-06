import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "./schema.js";

// Export the Drizzle instance type for use in context
export type DatabaseInstance = BetterSQLite3Database<typeof schema>;

// Re-export schema for convenience
export * from "./schema.js";

let db: DatabaseInstance | null = null;
let sqliteDb: Database.Database | null = null;

function getMigrationsFolder(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "../../drizzle");
}

function ensureMigrations(
  dbInstance: DatabaseInstance,
  sqlite: Database.Database
): void {
  const migrationsFolder = getMigrationsFolder();
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");

  if (!fs.existsSync(journalPath)) {
    console.log("[DB] No migrations journal found. Skipping migrations.");
    return;
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length === 0) {
    return;
  }

  // Ensure migrations table exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at numeric
    );
  `);

  const lastMigration = sqlite
    .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
    .get() as { hash: string; created_at: number } | undefined;

  // If this is an existing DB with tables but no migration history, baseline it.
  if (!lastMigration) {
    const hasSessions = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get();
    if (hasSessions) {
      const baseline = migrations[0];
      sqlite
        .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(baseline.hash, baseline.folderMillis);
      console.log("[DB] Baseline migration recorded for existing database.");
    }
  }

  migrate(dbInstance, { migrationsFolder });
}

export function initDb(): DatabaseInstance {
  const dbPath = process.env.AGENT_DB_PATH || "/data/agent.db";

  // Ensure directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  sqliteDb = new Database(dbPath);
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.pragma("foreign_keys = ON");

  // Create Drizzle instance with schema
  db = drizzle(sqliteDb, { schema });

  // Run migrations if present
  try {
    ensureMigrations(db, sqliteDb);
  } catch (error) {
    console.error("[DB] Migration failed:", error);
    throw error;
  }

  // Create tables if they don't exist
  // Legacy bootstrap: keep in sync with v1 baseline only.
  // Future schema changes should be migrations.
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

    -- WeChat encryption keys (per-session, per-account)
    CREATE TABLE IF NOT EXISTS wechat_keys (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      account_dir TEXT NOT NULL,
      db_name TEXT NOT NULL,
      hex_key TEXT NOT NULL,
      verified_at TEXT,
      UNIQUE(session_id, account_dir, db_name)
    );
    CREATE INDEX IF NOT EXISTS idx_wechat_keys_session_account ON wechat_keys(session_id, account_dir);

    -- Sync state table
    CREATE TABLE IF NOT EXISTS sync_state (
      session_id TEXT REFERENCES sessions(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, key)
    );

    -- Context table (FSM AppState persistence)
    CREATE TABLE IF NOT EXISTS context (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      app_state TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
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

export function getSqliteDb(): Database.Database {
  if (!sqliteDb) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return sqliteDb;
}

export function closeDb(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    db = null;
  }
}
