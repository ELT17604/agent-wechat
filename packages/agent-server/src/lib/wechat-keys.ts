/**
 * WeChat SQLCipher key extraction and storage.
 *
 * Keys are extracted from WeChat process memory using Frida,
 * then stored in the agent DB for subsequent queries.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import type { DatabaseInstance } from "../db/index.js";
import { wechatKeys } from "../db/schema.js";
import { getDbPath, listAccountDbs } from "./wechat-db.js";

interface ExtractKeysOutput {
  account: string;
  extracted_at: string;
  keys: Record<string, string>;  // { "session.db": "hex_key", ... }
}

/**
 * Extract all WeChat DB keys from process memory.
 *
 * Calls the wechat-extract-keys script which uses Frida to scan
 * the WeChat process memory for SQLCipher cipher_ctx structures,
 * extracts candidate keys, and verifies them against each database.
 *
 * Takes ~20 seconds. Blocks the calling thread.
 */
export function extractKeys(wechatPid: number): Record<string, string> {
  // Run extraction script, output to a temp file
  const outPath = `/tmp/wechat_keys_${wechatPid}.json`;

  try {
    try {
      execSync(
        `env HOME=/home/wechat python3 /opt/tools/wechat-extract-keys.py --pid ${wechatPid} --output ${outPath}`,
        {
          timeout: 120_000,  // 2 min max
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    } catch {
      // Script exits non-zero if some DBs fail (e.g. favorite_fts.db).
      // The JSON output file is still written with whatever keys were found.
    }

    // Read whatever keys were extracted (partial success is fine)
    if (fs.existsSync(outPath)) {
      const output: ExtractKeysOutput = JSON.parse(
        fs.readFileSync(outPath, "utf-8")
      );
      console.log(`[wechat-keys] Extracted ${Object.keys(output.keys).length} keys`);
      return output.keys;
    }

    return {};
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(outPath); } catch { /* ignore */ }
  }
}

/**
 * Get stored keys for a session + account from the agent DB.
 */
export function getStoredKeys(
  db: DatabaseInstance,
  sessionId: string,
  accountDir: string
): Record<string, string> {
  const rows = db
    .select({ dbName: wechatKeys.dbName, hexKey: wechatKeys.hexKey })
    .from(wechatKeys)
    .where(
      and(
        eq(wechatKeys.sessionId, sessionId),
        eq(wechatKeys.accountDir, accountDir)
      )
    )
    .all();

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.dbName] = row.hexKey;
  }
  return result;
}

/**
 * Store extracted keys in the agent DB.
 *
 * Upserts keys keyed by (session_id, account_dir, db_name).
 */
export function storeKeys(
  db: DatabaseInstance,
  sessionId: string,
  accountDir: string,
  keys: Record<string, string>
): void {
  const now = new Date().toISOString();

  for (const [dbName, hexKey] of Object.entries(keys)) {
    db.insert(wechatKeys)
      .values({
        id: randomUUID(),
        sessionId,
        accountDir,
        dbName,
        hexKey,
        verifiedAt: now,
      })
      .onConflictDoUpdate({
        target: [wechatKeys.sessionId, wechatKeys.accountDir, wechatKeys.dbName],
        set: {
          hexKey,
          verifiedAt: now,
        },
      })
      .run();
  }
}

/**
 * Verify a single key against a database file.
 * Returns true if the key successfully decrypts the database.
 */
export function verifyKey(dbPath: string, hexKey: string): boolean {
  try {
    const sql = [
      `PRAGMA key = "x'${hexKey}'";`,
      `PRAGMA cipher_compatibility = 4;`,
      `SELECT count(*) FROM sqlite_master;`,
    ].join("\n");

    const result = execSync(`sqlcipher "${dbPath}"`, {
      input: sql,
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    return true;  // exit code 0 = success
  } catch {
    return false;  // non-zero exit = wrong key
  }
}

/**
 * Verify stored keys still work. Returns list of DB names that failed.
 */
export function verifyStoredKeys(
  db: DatabaseInstance,
  sessionId: string,
  accountDir: string
): string[] {
  const keys = getStoredKeys(db, sessionId, accountDir);
  const failed: string[] = [];

  for (const [dbName, hexKey] of Object.entries(keys)) {
    const dbPath = getDbPath(accountDir, dbName);
    if (!verifyKey(dbPath, hexKey)) {
      failed.push(dbName);
    }
  }

  return failed;
}

/**
 * Check if key extraction is needed.
 *
 * Returns true if:
 * - No stored keys exist
 * - There are DB files on disk without a matching key
 * - Any stored key fails sqlcipher verification
 */
export function needsKeyExtraction(
  db: DatabaseInstance,
  sessionId: string,
  accountDir: string
): boolean {
  const storedKeys = getStoredKeys(db, sessionId, accountDir);

  // No keys at all → need extraction
  if (Object.keys(storedKeys).length === 0) {
    console.log("[wechat-keys] No stored keys, extraction needed");
    return true;
  }

  // Check for new DB files that we don't have keys for
  const existingDbs = listAccountDbs(accountDir);
  const missingKeys = existingDbs.filter(dbName => !storedKeys[dbName]);
  if (missingKeys.length > 0) {
    console.log(`[wechat-keys] Missing keys for: ${missingKeys.join(", ")}`);
    return true;
  }

  // Verify stored keys actually work (sqlcipher test)
  const failed = verifyStoredKeys(db, sessionId, accountDir);
  if (failed.length > 0) {
    console.log(`[wechat-keys] Keys failed verification: ${failed.join(", ")}`);
    return true;
  }

  console.log(`[wechat-keys] All ${Object.keys(storedKeys).length} keys valid`);
  return false;
}

/**
 * Clear all stored keys for a session.
 */
export function clearSessionKeys(
  db: DatabaseInstance,
  sessionId: string
): void {
  db.delete(wechatKeys)
    .where(eq(wechatKeys.sessionId, sessionId))
    .run();
}
