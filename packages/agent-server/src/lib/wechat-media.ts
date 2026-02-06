/**
 * Media extraction from WeChat's databases and filesystem.
 *
 * Handles images (.dat decryption via AES-128-ECB + XOR, with thumbnail cache fallback),
 * emoji (emoticon.db CDN URLs), and voice messages (media_0.db SILK BLOBs).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { MediaResult } from "@thisnick/agent-wechat-shared";
import { queryWechatDb, getDbPath } from "./wechat-db.js";
import { getMsgTableName, decompressHex } from "./wechat-messages.js";

/** ZSTD magic number */
const ZSTD_MAGIC = "28b52ffd";

/** WeChat .dat file magic bytes */
const DAT_MAGIC = Buffer.from("070856320807", "hex");

interface ImageKeys {
  aesKeyHex: string;
  xorByte: number | null;
}

interface MsgLookupRow {
  local_id: number;
  local_type: number;
  create_time: number;
  hex_content: string | null;
  is_compressed: number | null;
}

/**
 * Find both possible base paths for the WeChat account directory.
 */
function getAccountBasePaths(accountDir: string): string[] {
  return [
    path.join("/home/wechat/xwechat_files", accountDir),
    path.join("/home/wechat/Documents/xwechat_files", accountDir),
  ];
}

/**
 * Decode message content from hex, decompressing if needed.
 */
function decodeContent(hexContent: string | null, isCompressed: number | null): string {
  if (!hexContent) return "";
  if (isCompressed && hexContent.toLowerCase().startsWith(ZSTD_MAGIC)) {
    try {
      return decompressHex(hexContent);
    } catch {
      return "";
    }
  }
  return Buffer.from(hexContent, "hex").toString("utf-8");
}

/**
 * Look up a specific message by localId to get its type and content.
 */
function lookupMessage(
  accountDir: string,
  msgKey: string,
  chatId: string,
  localId: number,
): MsgLookupRow | null {
  const dbPath = getDbPath(accountDir, "message_0.db");
  const tableName = getMsgTableName(chatId);

  const rows = queryWechatDb(
    dbPath,
    msgKey,
    `SELECT local_id, local_type, create_time,
            hex(message_content) as hex_content,
            WCDB_CT_message_content as is_compressed
     FROM "${tableName}"
     WHERE local_id = ${localId}
     LIMIT 1;`,
  ) as unknown as MsgLookupRow[];

  return rows[0] ?? null;
}

/**
 * Get image thumbnail from filesystem cache.
 *
 * Path pattern: cache/{YYYY-MM}/Message/{md5(chatId)}/Thumb/{localId}_{createTime}_thumb.jpg
 */
export function getImageThumbnail(
  accountDir: string,
  keys: Record<string, string>,
  chatId: string,
  localId: number,
): MediaResult {
  const msgKey = keys["message_0.db"];
  if (!msgKey) return { type: "unsupported", format: "", filename: "" };

  const msg = lookupMessage(accountDir, msgKey, chatId, localId);
  if (!msg) return { type: "unsupported", format: "", filename: "" };

  const hash = crypto.createHash("md5").update(chatId).digest("hex");
  const date = new Date(msg.create_time * 1000);
  const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  const thumbName = `${localId}_${msg.create_time}_thumb.jpg`;

  for (const base of getAccountBasePaths(accountDir)) {
    const thumbPath = path.join(base, "cache", yearMonth, "Message", hash, "Thumb", thumbName);
    if (fs.existsSync(thumbPath)) {
      const data = fs.readFileSync(thumbPath).toString("base64");
      return {
        type: "image",
        data,
        format: "jpeg",
        filename: `msg_${localId}.jpg`,
      };
    }
  }

  // Thumbnail not found in cache - try finding any thumb matching this localId
  for (const base of getAccountBasePaths(accountDir)) {
    const thumbDir = path.join(base, "cache", yearMonth, "Message", hash, "Thumb");
    if (fs.existsSync(thumbDir)) {
      const files = fs.readdirSync(thumbDir);
      const match = files.find(f => f.startsWith(`${localId}_`));
      if (match) {
        const data = fs.readFileSync(path.join(thumbDir, match)).toString("base64");
        return {
          type: "image",
          data,
          format: "jpeg",
          filename: `msg_${localId}.jpg`,
        };
      }
    }
  }

  // It's an image message but thumbnail hasn't been cached by WeChat yet
  return { type: "image", format: "jpeg", filename: `msg_${localId}.jpg` };
}

/**
 * Get emoji CDN URL from emoticon.db.
 *
 * Extracts md5 from message XML, looks up CDN URL in emoticon.db.
 */
export function getEmojiMedia(
  accountDir: string,
  keys: Record<string, string>,
  chatId: string,
  localId: number,
): MediaResult {
  const msgKey = keys["message_0.db"];
  const emoticonKey = keys["emoticon.db"];
  if (!msgKey) return { type: "unsupported", format: "", filename: "" };

  const msg = lookupMessage(accountDir, msgKey, chatId, localId);
  if (!msg) return { type: "unsupported", format: "", filename: "" };

  // Decode and extract md5 from XML
  let content = decodeContent(msg.hex_content, msg.is_compressed);

  // Strip group sender prefix if present
  const nlIndex = content.indexOf(":\n");
  if (nlIndex !== -1 && nlIndex < 80) {
    content = content.slice(nlIndex + 2);
  }

  const md5Match = content.match(/md5="([a-f0-9]+)"/i);
  if (!md5Match) {
    return { type: "unsupported", format: "", filename: "" };
  }
  const md5 = md5Match[1];

  // Look up CDN URL from emoticon.db
  if (emoticonKey) {
    const emoticonDbPath = getDbPath(accountDir, "emoticon.db");
    const rows = queryWechatDb(
      emoticonDbPath,
      emoticonKey,
      `SELECT cdn_url FROM kNonStoreEmoticonTable WHERE md5 = '${md5}' LIMIT 1;`,
    ) as unknown as { cdn_url: string }[];

    if (rows.length > 0 && rows[0].cdn_url) {
      return {
        type: "emoji",
        url: rows[0].cdn_url,
        format: "gif",
        filename: `emoji_${md5}.gif`,
      };
    }
  }

  // Fallback: extract cdnurl directly from message XML
  const cdnMatch = content.match(/cdnurl="(https?:\/\/[^"]+)"/i);
  if (cdnMatch) {
    return {
      type: "emoji",
      url: cdnMatch[1],
      format: "gif",
      filename: `emoji_${md5}.gif`,
    };
  }

  return {
    type: "emoji",
    format: "unknown",
    filename: `emoji_${md5}`,
  };
}

/**
 * Get voice data from media_0.db.
 *
 * Voice messages are stored as SILK_V3 BLOBs in the VoiceInfo table.
 */
export function getVoiceData(
  accountDir: string,
  keys: Record<string, string>,
  chatId: string,
  localId: number,
): MediaResult {
  const mediaKey = keys["media_0.db"];
  if (!mediaKey) return { type: "unsupported", format: "", filename: "" };

  const mediaDbPath = getDbPath(accountDir, "media_0.db");

  // Map chatId to Name2Id integer
  const nameRows = queryWechatDb(
    mediaDbPath,
    mediaKey,
    `SELECT rowid FROM Name2Id WHERE user_name = '${chatId.replace(/'/g, "''")}';`,
  ) as unknown as { rowid: number }[];

  if (nameRows.length === 0) return { type: "unsupported", format: "", filename: "" };
  const chatNameId = nameRows[0].rowid;

  // Fetch voice data as hex
  const voiceRows = queryWechatDb(
    mediaDbPath,
    mediaKey,
    `SELECT hex(voice_data) as hex_data, length(voice_data) as size
     FROM VoiceInfo
     WHERE chat_name_id = ${chatNameId} AND local_id = ${localId}
     LIMIT 1;`,
  ) as unknown as { hex_data: string; size: number }[];

  if (voiceRows.length === 0 || !voiceRows[0].hex_data) {
    return { type: "unsupported", format: "", filename: "" };
  }

  const data = Buffer.from(voiceRows[0].hex_data, "hex").toString("base64");
  return {
    type: "voice",
    data,
    format: "silk",
    filename: `msg_${localId}.silk`,
  };
}

/**
 * AES-decrypt just the head of a .dat file (no XOR byte needed).
 * Used to detect image type and derive the XOR byte.
 */
function decryptDatHead(datBuf: Buffer, aesKeyHex: string): { decHead: Buffer; encChunkSize: number } {
  if (!datBuf.subarray(0, 6).equals(DAT_MAGIC)) {
    throw new Error("Not a WeChat .dat file");
  }

  const encChunkSize = datBuf.readUInt32LE(6);
  const aesKey = Buffer.from(aesKeyHex.slice(0, 16), "ascii");

  const aesCt = datBuf.subarray(15, 15 + encChunkSize + 16);
  const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
  const decHead = Buffer.concat([decipher.update(aesCt), decipher.final()]);

  return { decHead, encChunkSize };
}

/**
 * Derive the XOR byte from a .dat file by checking known image trailers.
 *
 * JPEG ends with FF D9, PNG ends with IEND chunk (AE 42 60 82).
 * Since we know the decrypted head (and thus the image type), we can
 * XOR the known trailer against the encrypted tail to find the byte.
 */
function deriveXorByte(datBuf: Buffer, decHead: Buffer): number | null {
  // JPEG: last 2 bytes of original are FF D9
  if (decHead[0] === 0xff && decHead[1] === 0xd8) {
    const c1 = datBuf[datBuf.length - 2]! ^ 0xFF;
    const c2 = datBuf[datBuf.length - 1]! ^ 0xD9;
    if (c1 === c2) return c1;
  }

  // PNG: last 8 bytes are IEND chunk (49 45 4E 44 AE 42 60 82)
  if (decHead.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    const expected = [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];
    const tailStart = datBuf.length - 8;
    const xb = datBuf[tailStart]! ^ expected[0]!;
    if (expected.every((e, i) => (datBuf[tailStart + i]! ^ xb) === e)) return xb;
  }

  return null;
}

/**
 * Decrypt a WeChat .dat image file.
 *
 * Format: 15-byte header + AES-128-ECB chunk (1024+16 bytes) + XOR'd tail.
 * AES key = first 16 ASCII chars of the 32-char hex string (NOT hex-decoded).
 */
function decryptDat(datBuf: Buffer, aesKeyHex: string, xorByte: number): Buffer {
  const { decHead, encChunkSize } = decryptDatHead(datBuf, aesKeyHex);

  // XOR decrypt remaining bytes
  const tail = datBuf.subarray(15 + encChunkSize + 16);
  const decTail = Buffer.alloc(tail.length);
  for (let i = 0; i < tail.length; i++) {
    decTail[i] = tail[i]! ^ xorByte;
  }

  return Buffer.concat([decHead, decTail]);
}

/**
 * Detect image format from magic bytes.
 */
function detectImageFormat(data: Buffer): { format: string; ext: string } {
  if (data[0] === 0xff && data[1] === 0xd8) return { format: "jpeg", ext: "jpg" };
  if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
    return { format: "png", ext: "png" };
  if (data.subarray(0, 4).toString("ascii") === "GIF8")
    return { format: "gif", ext: "gif" };
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP")
    return { format: "webp", ext: "webp" };
  if (data.subarray(0, 4).toString("ascii") === "wxgf")
    return { format: "wxgf", ext: "wxgf" };
  return { format: "unknown", ext: "bin" };
}

/**
 * Get the Img directory path for a chat's images.
 *
 * Path format: <base>/msg/attach/<md5(chatId)>/<YYYY-MM>/Img/
 * The dir2id table in hardlink.db stores md5(chatId) as the username.
 */
function getImgDir(accountDir: string, chatId: string, createTime: number): string | null {
  const chatHash = crypto.createHash("md5").update(chatId).digest("hex");
  const date = new Date(createTime * 1000);
  const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  for (const base of getAccountBasePaths(accountDir)) {
    const imgDir = path.join(base, "msg", "attach", chatHash, yearMonth, "Img");
    if (fs.existsSync(imgDir)) return imgDir;
  }
  return null;
}

/**
 * Extract image md5 from message XML content.
 *
 * Image messages (type 3) contain XML like:
 *   <img md5="e9516071e880fe080e69d54d08ce12d1" ... />
 */
function extractImageMd5(
  accountDir: string,
  msgKey: string,
  chatId: string,
  localId: number,
): string | null {
  const msg = lookupMessage(accountDir, msgKey, chatId, localId);
  if (!msg) return null;

  const content = decodeContent(msg.hex_content, msg.is_compressed);
  // Strip group sender prefix (e.g. "user:\n<xml...")
  const xmlStart = content.indexOf("<");
  const xml = xmlStart >= 0 ? content.slice(xmlStart) : content;

  const md5Match = xml.match(/\bmd5="([a-f0-9]{32})"/i);
  return md5Match?.[1] ?? null;
}

/**
 * Find a .dat file for an image message via hardlink.db.
 *
 * Uses the image md5 from message XML to look up the file_name in
 * hardlink.db's image_hardlink_info_v4 table.
 *
 * dir2id maps directory names (md5 hashes, year-months) → rowid.
 * image_hardlink_info_v4 uses dir1 (chat rowid) and dir2 (date rowid).
 */
function findDatFileViaHardlink(
  accountDir: string,
  keys: Record<string, string>,
  chatId: string,
  localId: number,
): string | null {
  const hardlinkKey = keys["hardlink.db"];
  const msgKey = keys["message_0.db"];
  if (!hardlinkKey || !msgKey) return null;

  const imageMd5 = extractImageMd5(accountDir, msgKey, chatId, localId);
  if (!imageMd5) return null;

  const hardlinkDbPath = getDbPath(accountDir, "hardlink.db");

  // Look up by image content md5
  const fileRows = queryWechatDb(hardlinkDbPath, hardlinkKey,
    `SELECT file_name, dir1, dir2 FROM image_hardlink_info_v4
     WHERE md5 = '${imageMd5}' LIMIT 2;`,
  ) as unknown as { file_name: string; dir1: number; dir2: number }[];
  if (fileRows.length === 0) return null;

  // Resolve dir1 (chat hash) and dir2 (year-month) from dir2id
  const row = fileRows[0]!;
  const dirNames = queryWechatDb(hardlinkDbPath, hardlinkKey,
    `SELECT rowid, username FROM dir2id WHERE rowid IN (${row.dir1}, ${row.dir2});`,
  ) as unknown as { rowid: number; username: string }[];

  const dirMap = new Map(dirNames.map(d => [d.rowid, d.username]));
  const chatDir = dirMap.get(row.dir1);
  const dateDir = dirMap.get(row.dir2);
  if (!chatDir || !dateDir) return null;

  const fileName = row.file_name;
  for (const base of getAccountBasePaths(accountDir)) {
    const datPath = path.join(base, "msg", "attach", chatDir, dateDir, "Img", fileName);
    if (fs.existsSync(datPath)) return datPath;
  }
  return null;
}

/**
 * Fallback: find a .dat file by scanning the filesystem.
 *
 * mtime correlation isn't reliable (download time ≠ message time),
 * so we scan for any non-thumbnail .dat or fall back to _t.dat thumbnails.
 */
function findDatByFilescan(
  accountDir: string,
  chatId: string,
  createTime: number,
): string | null {
  const imgDir = getImgDir(accountDir, chatId, createTime);
  if (!imgDir) return null;

  const allFiles = fs.readdirSync(imgDir).filter(f => f.endsWith(".dat"));

  // Try mtime matching on full-size files first
  const fullFiles = allFiles.filter(f => !f.endsWith("_t.dat") && !f.endsWith("_h.dat"));
  for (const file of fullFiles) {
    try {
      const stat = fs.statSync(path.join(imgDir, file));
      if (Math.abs(Math.floor(stat.mtimeMs / 1000) - createTime) <= 120) {
        return path.join(imgDir, file);
      }
    } catch { /* skip */ }
  }

  // Try mtime matching on thumbnails (_t.dat → JPEG after decryption)
  const thumbFiles = allFiles.filter(f => f.endsWith("_t.dat"));
  for (const file of thumbFiles) {
    try {
      const stat = fs.statSync(path.join(imgDir, file));
      if (Math.abs(Math.floor(stat.mtimeMs / 1000) - createTime) <= 120) {
        return path.join(imgDir, file);
      }
    } catch { /* skip */ }
  }

  return null;
}

/**
 * Resolve the XOR byte: use stored value, or derive from the .dat file.
 *
 * If the current file is WXGF (not JPEG/PNG), the trailer-based derivation
 * won't work. In that case, scan the same directory for a JPEG _t.dat
 * thumbnail to derive the XOR byte from.
 */
function resolveXorByte(
  datPath: string,
  datBuf: Buffer,
  imageKeys: ImageKeys,
  onXorDerived?: (xorByte: number) => void,
): number | null {
  if (imageKeys.xorByte !== null) return imageKeys.xorByte;

  // Try deriving from this .dat file
  const { decHead } = decryptDatHead(datBuf, imageKeys.aesKeyHex);
  let xorByte = deriveXorByte(datBuf, decHead);

  // If this file is WXGF/unknown, try any JPEG _t.dat in the same directory
  if (xorByte === null) {
    const dir = path.dirname(datPath);
    try {
      const siblings = fs.readdirSync(dir).filter(f => f.endsWith("_t.dat"));
      for (const sib of siblings) {
        try {
          const sibBuf = fs.readFileSync(path.join(dir, sib));
          if (!sibBuf.subarray(0, 6).equals(DAT_MAGIC)) continue;
          const { decHead: sibHead } = decryptDatHead(sibBuf, imageKeys.aesKeyHex);
          xorByte = deriveXorByte(sibBuf, sibHead);
          if (xorByte !== null) break;
        } catch { /* skip bad files */ }
      }
    } catch { /* dir read failed */ }
  }

  if (xorByte !== null) {
    console.log(`[media] Derived XOR byte: 0x${xorByte.toString(16).padStart(2, "0")}`);
    onXorDerived?.(xorByte);
  }
  return xorByte;
}

/**
 * Decrypt a .dat file and return its raw decrypted buffer.
 */
function decryptDatFile(
  datPath: string,
  imageKeys: ImageKeys,
  onXorDerived?: (xorByte: number) => void,
): Buffer | null {
  const datBuf = fs.readFileSync(datPath);
  const xorByte = resolveXorByte(datPath, datBuf, imageKeys, onXorDerived);
  if (xorByte === null) {
    console.error(`[media] Could not derive XOR byte from ${datPath}`);
    return null;
  }
  return decryptDat(datBuf, imageKeys.aesKeyHex, xorByte);
}

/**
 * Decrypt a .dat file and return as MediaResult.
 *
 * If the decrypted file is WXGF (WeChat proprietary format), tries the
 * corresponding _t.dat thumbnail instead (always JPEG after decryption).
 */
function decryptAndReturn(
  datPath: string,
  imageKeys: ImageKeys,
  localId: number,
  onXorDerived?: (xorByte: number) => void,
): MediaResult {
  try {
    const decrypted = decryptDatFile(datPath, imageKeys, onXorDerived);
    if (!decrypted) {
      return { type: "image", format: "jpeg", filename: `msg_${localId}.jpg` };
    }

    const { format, ext } = detectImageFormat(decrypted);

    // WXGF is a WeChat-proprietary format we can't render — try thumbnail instead
    if (format === "wxgf") {
      const thumbPath = datPath.replace(/\.dat$/, "_t.dat");
      if (fs.existsSync(thumbPath)) {
        console.log(`[media] Full image is WXGF, falling back to thumbnail: ${thumbPath}`);
        const thumbDecrypted = decryptDatFile(thumbPath, imageKeys);
        if (thumbDecrypted) {
          const thumbFmt = detectImageFormat(thumbDecrypted);
          return {
            type: "image",
            data: thumbDecrypted.toString("base64"),
            format: thumbFmt.format,
            filename: `msg_${localId}.${thumbFmt.ext}`,
          };
        }
      }
      // Return WXGF as-is if no thumbnail (client may not be able to render)
      console.log(`[media] Returning WXGF image (no thumbnail available)`);
    }

    return {
      type: "image",
      data: decrypted.toString("base64"),
      format,
      filename: `msg_${localId}.${ext}`,
    };
  } catch (err) {
    console.error(`[media] Failed to decrypt ${datPath}:`, err);
    return { type: "image", format: "jpeg", filename: `msg_${localId}.jpg` };
  }
}

/**
 * Get a decrypted image from a .dat file, with thumbnail cache fallback.
 *
 * Priority:
 * 1. Cached thumbnail (fast, no decryption needed)
 * 2. Decrypt full .dat file via hardlink.db path resolution
 * 3. Decrypt full .dat file via filesystem mtime scan
 * 4. Return placeholder (image exists but can't be retrieved)
 *
 * If XOR byte is not yet known, it is derived from the first .dat file
 * decrypted and persisted via onXorDerived callback.
 */
export function getImageDecrypted(
  accountDir: string,
  keys: Record<string, string>,
  imageKeys: ImageKeys | null,
  chatId: string,
  localId: number,
  onXorDerived?: (xorByte: number) => void,
): MediaResult {
  // Try cached thumbnail first (fast path)
  const thumb = getImageThumbnail(accountDir, keys, chatId, localId);
  if (thumb.data) return thumb;

  // If no image keys, can't decrypt .dat files
  if (!imageKeys) return thumb;

  // Try hardlink.db path resolution (uses md5 from message XML)
  const datPath = findDatFileViaHardlink(accountDir, keys, chatId, localId);
  if (datPath) {
    console.log(`[media] Found .dat via hardlink.db: ${datPath}`);
    return decryptAndReturn(datPath, imageKeys, localId, onXorDerived);
  }

  // Fallback: filesystem scan using message createTime
  const msgKey = keys["message_0.db"];
  if (msgKey) {
    const msg = lookupMessage(accountDir, msgKey, chatId, localId);
    if (msg) {
      const scanPath = findDatByFilescan(accountDir, chatId, msg.create_time);
      if (scanPath) {
        console.log(`[media] Found .dat via filescan: ${scanPath}`);
        return decryptAndReturn(scanPath, imageKeys, localId, onXorDerived);
      }
      console.log(`[media] No .dat file found for localId=${localId}, createTime=${msg.create_time}`);
    }
  }

  return thumb;
}

/**
 * Get media for a message, dispatching by type.
 */
export function getMessageMedia(
  accountDir: string,
  keys: Record<string, string>,
  chatId: string,
  localId: number,
  imageKeys?: ImageKeys | null,
  onXorDerived?: (xorByte: number) => void,
): MediaResult {
  const msgKey = keys["message_0.db"];
  if (!msgKey) return { type: "unsupported", format: "", filename: "" };

  const msg = lookupMessage(accountDir, msgKey, chatId, localId);
  if (!msg) return { type: "unsupported", format: "", filename: "" };

  const base = msg.local_type & 0xFFFFFFFF;

  switch (base) {
    case 3:  // image
      return getImageDecrypted(accountDir, keys, imageKeys ?? null, chatId, localId, onXorDerived);
    case 34: // voice
      return getVoiceData(accountDir, keys, chatId, localId);
    case 47: // emoji
      return getEmojiMedia(accountDir, keys, chatId, localId);
    default: {
      // For other types (e.g. appmsg links), check if a cached thumbnail exists
      const thumb = getImageThumbnail(accountDir, keys, chatId, localId);
      if (thumb.data) return thumb;
      return { type: "unsupported", format: "", filename: "" };
    }
  }
}
