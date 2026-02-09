/**
 * Message reads from WeChat's message databases.
 *
 * Each chat's messages are stored in a `Msg_{MD5(username)}` table.
 * Non-text content is zstd-compressed (WCDB_CT_message_content = 4).
 */

import crypto from "crypto";
import { decompress } from "fzstd";
import type { Message } from "@thisnick/agent-wechat-shared";
import { queryWechatDb, getDbPath } from "./wechat-db.js";

interface MsgRawRow {
  local_id: number;
  server_id: number;
  local_type: number;
  create_time: number;
  status: number;
  hex_content: string | null;
  is_compressed: number | null;
}

/** ZSTD magic number: 0xFD2FB528 */
const ZSTD_MAGIC = "28b52ffd";

/**
 * Get the Msg table name for a given chat username.
 * WeChat uses MD5(username) as the table suffix.
 */
export function getMsgTableName(chatUsername: string): string {
  const hash = crypto.createHash("md5").update(chatUsername).digest("hex");
  return `Msg_${hash}`;
}

/**
 * Decode WeChat's compound message type.
 * Format: (sub_type << 32) | base_type
 */
function decodeType(localType: number): { base: number; sub: number } {
  const base = localType & 0xFFFFFFFF;
  const sub = Math.floor(localType / 0x100000000);
  return { base, sub };
}

/**
 * Decompress zstd content from hex string, returning UTF-8 text.
 */
export function decompressHex(hex: string): string {
  const buf = Buffer.from(hex, "hex");
  const decompressed = decompress(new Uint8Array(buf));
  return Buffer.from(decompressed).toString("utf-8");
}

/**
 * Extract a readable summary from appmsg XML (type 49).
 * Pulls the <title> element which contains the main text.
 */
function extractAppMsgTitle(xml: string): string | null {
  const match = xml.match(/<title>([\s\S]*?)<\/title>/);
  return match ? match[1].trim() : null;
}

/**
 * List messages for a specific chat from WeChat's message_0.db.
 *
 * Messages are returned newest-first by default.
 * Compressed content (zstd) is automatically decompressed.
 */
export function listMessagesFromWechatDb(
  accountDir: string,
  keys: Record<string, string>,
  chatId: string,
  limit: number = 50,
  offset: number = 0,
): Message[] {
  const msgKey = keys["message_0.db"];
  if (!msgKey) return [];

  const dbPath = getDbPath(accountDir, "message_0.db");
  const tableName = getMsgTableName(chatId);

  // Check if the table exists (chat may have no messages in this DB)
  const tableCheck = queryWechatDb(
    dbPath,
    msgKey,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}';`,
  ) as unknown as { name: string }[];

  if (tableCheck.length === 0) return [];

  const isGroup = chatId.includes("@chatroom");

  // Fetch hex-encoded content + compression flag
  const rows = queryWechatDb(
    dbPath,
    msgKey,
    `SELECT local_id, server_id, local_type, create_time, status,
            hex(message_content) as hex_content,
            WCDB_CT_message_content as is_compressed
     FROM "${tableName}"
     ORDER BY create_time DESC
     LIMIT ${limit} OFFSET ${offset};`,
  ) as unknown as MsgRawRow[];

  return rows.map((row): Message => {
    let content = "";
    let sender: string | undefined;
    const { base, sub } = decodeType(row.local_type);

    // Decompress if needed
    if (row.hex_content) {
      if (row.is_compressed && row.hex_content.toLowerCase().startsWith(ZSTD_MAGIC)) {
        try {
          content = decompressHex(row.hex_content);
        } catch {
          content = "[compressed content - decompression failed]";
        }
      } else {
        // Plain text: decode hex to UTF-8
        content = Buffer.from(row.hex_content, "hex").toString("utf-8");
      }
    }

    // Extract sender from group messages ("sender_id:\ncontent")
    // Messages sent by self don't have the sender prefix
    if (isGroup && content) {
      const nlIndex = content.indexOf(":\n");
      if (nlIndex !== -1 && nlIndex < 80) {
        sender = content.slice(0, nlIndex);
        content = content.slice(nlIndex + 2);
      } else {
        // No prefix = sent by self. Extract wxid from accountDir (e.g. "wxid_xxx_abc123" → "wxid_xxx")
        const wxidMatch = accountDir.match(/^(wxid_[^_]+)/);
        sender = wxidMatch ? wxidMatch[1] : accountDir;
      }
    }

    // For appmsg (type 49), extract title for readability
    if (base === 49 && content.includes("<msg>")) {
      const title = extractAppMsgTitle(content);
      if (title) {
        content = title;
      }
    }

    // For image (type 3), replace XML with placeholder
    if (base === 3 && content.includes("<img")) {
      content = "";
    }

    // For emoji (type 47), replace XML with description or placeholder
    if (base === 47 && content.includes("<emoji")) {
      const descMatch = content.match(/desc="([^"]+)"/);
      content = descMatch ? descMatch[1] : "";
    }

    return {
      localId: row.local_id,
      serverId: row.server_id,
      chatId,
      sender,
      type: row.local_type,
      content,
      timestamp: new Date(row.create_time * 1000).toISOString(),
    };
  });
}
