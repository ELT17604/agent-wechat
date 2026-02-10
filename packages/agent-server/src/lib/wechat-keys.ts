/**
 * WeChat DB credential management.
 *
 * Handles extraction, storage, and verification of DB access credentials.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { execCommand } from "./exec.js";
import type { DatabaseInstance } from "../db/index.js";
import { wechatKeys } from "../db/schema.js";
import { getDbPath, listAccountDbs } from "./wechat-db.js";

interface ExtractKeysOutput {
  account: string;
  extracted_at: string;
  keys: Record<string, string>;  // { "session.db": "hex_key", ... }
}

/**
 * Extract all WeChat DB access credentials.
 *
 * Takes ~20 seconds. Blocks the calling thread.
 */
export function extractKeys(wechatPid: number): Record<string, string> {
  // Run extraction script, output to a temp file
  const outPath = `/tmp/wechat_keys_${wechatPid}.json`;

  try {
    try {
      execSync(
        `env HOME=/home/wechat python3 /opt/tools/extract-keys.py --pid ${wechatPid} --output ${outPath}`,
        {
          timeout: 120_000,  // 2 min max
          encoding: "utf-8",
          stdio: ["pipe", "inherit", "inherit"],
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
      const dbKeys = Object.keys(output.keys).filter(k => !k.startsWith("_"));
      const hasImageAes = !!output.keys["_image_aes"];
      console.log(`[wechat-keys] Extracted ${dbKeys.length} DB keys, image key: ${hasImageAes ? "yes" : "no"}`);
      if (hasImageAes) {
        console.log(`[wechat-keys]   _image_aes: ${output.keys["_image_aes"]!.slice(0, 16)}...`);
      }
      return output.keys;
    }

    return {};
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(outPath); } catch { /* ignore */ }
  }
}

/**
 * Extract all WeChat DB access credentials (async, non-blocking).
 *
 * Same as extractKeys but uses execCommand instead of execSync.
 */
export async function extractKeysAsync(wechatPid: number): Promise<Record<string, string>> {
  const outPath = `/tmp/wechat_keys_${wechatPid}.json`;

  // Script may exit non-zero if some DBs fail — partial success is fine.
  // execCommand always resolves (never rejects).
  await execCommand(
    "env",
    ["HOME=/home/wechat", "python3", "/opt/tools/extract-keys.py", "--pid", String(wechatPid), "--output", outPath],
    { timeout: 120_000 }
  );

  try {
    if (fs.existsSync(outPath)) {
      const output: ExtractKeysOutput = JSON.parse(
        fs.readFileSync(outPath, "utf-8")
      );
      const dbKeys = Object.keys(output.keys).filter(k => !k.startsWith("_"));
      const hasImageAes = !!output.keys["_image_aes"];
      console.log(`[wechat-keys] Extracted ${dbKeys.length} DB keys, image key: ${hasImageAes ? "yes" : "no"}`);
      if (hasImageAes) {
        console.log(`[wechat-keys]   _image_aes: ${output.keys["_image_aes"]!.slice(0, 16)}...`);
      }
      return output.keys;
    }
    return {};
  } finally {
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
 * Returns true if the key successfully opens the database.
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
    if (dbName.startsWith("_")) continue; // Skip non-DB entries (image keys, etc.)
    const t = Date.now();
    const dbPath = getDbPath(accountDir, dbName);
    const ok = verifyKey(dbPath, hexKey);
    console.log(`[wechat-keys]   verify ${dbName}: ${ok ? "ok" : "FAILED"} (${Date.now() - t}ms)`);
    if (!ok) {
      failed.push(dbName);
    }
  }

  return failed;
}

/**
 * Check if credential setup is needed.
 *
 * Returns true if:
 * - No stored keys exist
 * - There are DB files on disk without a matching key
 * - Any stored key fails verification
 */
export function needsKeyExtraction(
  db: DatabaseInstance,
  sessionId: string,
  accountDir: string
): boolean {
  const t0 = Date.now();
  const storedKeys = getStoredKeys(db, sessionId, accountDir);

  // No keys at all → need extraction
  if (Object.keys(storedKeys).length === 0) {
    console.log("[wechat-keys] No stored keys, extraction needed");
    return true;
  }

  // Only require keys for DBs we actually query.
  // message_N.db and media_N.db are sharded — match by prefix.
  const REQUIRED_EXACT = new Set(["session.db", "contact.db", "emoticon.db", "head_image.db", "hardlink.db"]);
  const REQUIRED_PREFIXES = ["message_", "media_"];
  const isRequired = (dbName: string) =>
    REQUIRED_EXACT.has(dbName) || REQUIRED_PREFIXES.some(p => dbName.startsWith(p));
  const t1 = Date.now();
  const existingDbs = listAccountDbs(accountDir);
  const missingKeys = existingDbs.filter(dbName => isRequired(dbName) && !storedKeys[dbName]);
  console.log(`[wechat-keys] DB scan: ${existingDbs.length} files, ${missingKeys.length} missing keys (${Date.now() - t1}ms)`);
  if (missingKeys.length > 0) {
    console.log(`[wechat-keys] Missing keys for: ${missingKeys.join(", ")}`);
    return true;
  }

  // Spot-check: verify just one key as a sanity check.
  // If one works, the rest almost certainly do (same extraction session).
  const t2 = Date.now();
  const checkDb = storedKeys["session.db"] ? "session.db" : Object.keys(storedKeys)[0];
  const checkKey = storedKeys[checkDb];
  const checkPath = getDbPath(accountDir, checkDb);
  const ok = verifyKey(checkPath, checkKey);
  console.log(`[wechat-keys] Spot-check ${checkDb}: ${ok ? "ok" : "FAILED"} (${Date.now() - t2}ms)`);
  if (!ok) {
    console.log(`[wechat-keys] Spot-check failed, re-extraction needed`);
    return true;
  }

  const hasImageAes = !!storedKeys["_image_aes"];
  const hasImageXor = !!storedKeys["_image_xor"];
  console.log(`[wechat-keys] ${Object.keys(storedKeys).length} keys stored, spot-check passed, image keys: aes=${hasImageAes} xor=${hasImageXor} (total: ${Date.now() - t0}ms)`);
  return false;
}

/**
 * Get stored image access keys for a session + account.
 *
 * Returns { aesKeyHex, xorByte? } or null if not available.
 */
export function getImageKeys(
  db: DatabaseInstance,
  sessionId: string,
  accountDir: string
): { aesKeyHex: string; xorByte: number | null } | null {
  const keys = getStoredKeys(db, sessionId, accountDir);
  const aesHex = keys["_image_aes"];
  if (!aesHex) return null;
  const xorHex = keys["_image_xor"];
  return {
    aesKeyHex: aesHex,
    xorByte: xorHex ? parseInt(xorHex, 16) : null,
  };
}

/**
 * Store a single key (e.g. derived _image_xor) into wechat_keys.
 */
export function storeSingleKey(
  db: DatabaseInstance,
  sessionId: string,
  accountDir: string,
  dbName: string,
  hexKey: string,
): void {
  storeKeys(db, sessionId, accountDir, { [dbName]: hexKey });
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
