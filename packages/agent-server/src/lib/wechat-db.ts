/**
 * WeChat SQLCipher database query helpers.
 *
 * Uses the `sqlcipher` CLI (built from source in the Docker image)
 * to query WeChat's encrypted databases.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

/**
 * Query a WeChat SQLCipher database and return parsed rows.
 *
 * Uses `-json` output mode for structured results. Falls back to raw
 * string output if json mode produces no results.
 */
export function queryWechatDb(
  dbPath: string,
  hexKey: string,
  sql: string
): Record<string, unknown>[] {
  const input = [
    `PRAGMA key = "x'${hexKey}'";`,
    `PRAGMA cipher_compatibility = 4;`,
    `.mode json`,
    sql,
  ].join("\n");

  const result = execSync(`sqlcipher "${dbPath}"`, {
    input,
    timeout: 10_000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const trimmed = result.trim();
  if (!trimmed) return [];

  // sqlcipher outputs "ok" for PRAGMAs before the JSON array.
  // Find the JSON array in the output.
  const jsonStart = trimmed.indexOf("[");
  if (jsonStart === -1) return [];

  const jsonStr = trimmed.slice(jsonStart);
  if (jsonStr === "[]") return [];

  try {
    return JSON.parse(jsonStr);
  } catch {
    return [];
  }
}

/**
 * Find the WeChat process PID.
 *
 * pgrep may return multiple PIDs (parent su wrapper + actual wechat).
 * We need the one that actually has open db_storage files, so we
 * try each candidate and return the first with readable /proc/pid/fd.
 */
export function findWechatPid(): number | null {
  try {
    const output = execSync("pgrep -f /usr/bin/wechat", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const pids = output.split("\n").map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n > 0);

    // Return the PID with the most open file descriptors (the real process)
    let bestPid: number | null = null;
    let bestFdCount = 0;
    for (const pid of pids) {
      try {
        const fdCount = fs.readdirSync(`/proc/${pid}/fd`).length;
        if (fdCount > bestFdCount) {
          bestFdCount = fdCount;
          bestPid = pid;
        }
      } catch {
        // Can't read this PID's fds
      }
    }
    return bestPid;
  } catch {
    // pgrep returns exit code 1 if no match
  }
  return null;
}

/**
 * Detect the WeChat account directory by scanning /proc/<pid>/fd
 * for open database files.
 *
 * Returns the account directory name (e.g. "wxid_abc123_def456")
 * or null if not found.
 */
export function findAccountDir(wechatPid: number): string | null {
  try {
    const fdDir = `/proc/${wechatPid}/fd`;
    const fds = fs.readdirSync(fdDir);

    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(path.join(fdDir, fd));
        if (target.includes("db_storage") && target.endsWith(".db")) {
          const idx = target.indexOf("xwechat_files/");
          if (idx >= 0) {
            const rest = target.slice(idx + "xwechat_files/".length);
            const accountDir = rest.split("/")[0];
            if (accountDir) return accountDir;
          }
        }
      } catch {
        // Skip unreadable fds
        continue;
      }
    }
  } catch {
    // /proc not available or permission denied
  }
  return null;
}

/**
 * List all .db files that exist on disk for a given account.
 * Returns db names like ["session.db", "contact.db", ...].
 */
export function listAccountDbs(accountDir: string): string[] {
  const dbNames: string[] = [];

  for (const base of [
    path.join("/home/wechat/xwechat_files", accountDir),
    path.join("/home/wechat/Documents/xwechat_files", accountDir),
  ]) {
    const dbStorageDir = path.join(base, "db_storage");
    if (!fs.existsSync(dbStorageDir)) continue;

    // Scan subdirectories for .db files
    for (const subDir of fs.readdirSync(dbStorageDir)) {
      const subPath = path.join(dbStorageDir, subDir);
      if (!fs.statSync(subPath).isDirectory()) continue;

      for (const file of fs.readdirSync(subPath)) {
        if (file.endsWith(".db")) {
          dbNames.push(file);
        }
      }
    }
    if (dbNames.length > 0) return dbNames;
  }

  return dbNames;
}

/**
 * Get the full path to a WeChat database file.
 *
 * Maps db names like "session.db" to their subdirectory:
 *   session.db → db_storage/session/session.db
 *   contact.db → db_storage/contact/contact.db
 *   message_0.db → db_storage/message/message_0.db
 */
export function getDbPath(accountDir: string, dbName: string): string {
  // Map db names to their subdirectories
  const subDirMap: Record<string, string> = {
    "contact.db": "contact",
    "contact_fts.db": "contact",
    "session.db": "session",
    "message_0.db": "message",
    "message_fts.db": "message",
    "message_resource.db": "message",
    "biz_message_0.db": "message",
    "media_0.db": "message",
    "general.db": "general",
    "hardlink.db": "hardlink",
    "head_image.db": "head_image",
    "emoticon.db": "emoticon",
    "favorite.db": "favorite",
    "favorite_fts.db": "favorite",
    "sns.db": "sns",
    "bizchat.db": "bizchat",
  };

  const subDir = subDirMap[dbName] || dbName.replace(/\.db$/, "");

  // Check both possible base paths
  for (const base of [
    path.join("/home/wechat/xwechat_files", accountDir),
    path.join("/home/wechat/Documents/xwechat_files", accountDir),
  ]) {
    const fullPath = path.join(base, "db_storage", subDir, dbName);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  // Default to first path even if not found
  return path.join(
    "/home/wechat/xwechat_files",
    accountDir,
    "db_storage",
    subDir,
    dbName
  );
}
