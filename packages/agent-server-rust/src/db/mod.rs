pub mod queries;

use refinery::embed_migrations;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

embed_migrations!("migrations");

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Initialize the database: run migrations, set pragmas.
pub fn init_db() -> Result<(), String> {
    let db_path = std::env::var("AGENT_DB_PATH").unwrap_or_else(|_| "/data/agent.db".to_string());

    // Ensure directory exists
    if let Some(parent) = Path::new(&db_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create db dir: {e}"))?;
    }

    let mut conn = Connection::open(&db_path).map_err(|e| format!("Failed to open db: {e}"))?;

    conn.execute_batch("PRAGMA journal_mode = WAL;")
        .map_err(|e| format!("Failed to set WAL: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("Failed to enable FK: {e}"))?;

    // Run embedded migrations
    migrations::runner()
        .run(&mut conn)
        .map_err(|e| format!("Failed to run migrations: {e}"))?;

    DB.set(Mutex::new(conn))
        .map_err(|_| "Database already initialized".to_string())?;

    tracing::info!("[DB] Initialized at {db_path}");
    Ok(())
}

/// Get a reference to the database connection.
/// Panics if init_db() hasn't been called.
pub fn get_db() -> std::sync::MutexGuard<'static, Connection> {
    DB.get()
        .expect("Database not initialized. Call init_db() first.")
        .lock()
        .expect("Database mutex poisoned")
}
