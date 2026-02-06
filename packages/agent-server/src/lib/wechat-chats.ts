/**
 * Chat list from WeChat's encrypted databases.
 *
 * Queries session.db and contact.db to build the chat list,
 * replacing the old RPA-based sync approach.
 */

import type { Chat } from "@thisnick/agent-wechat-shared";
import { queryWechatDb, getDbPath } from "./wechat-db.js";

interface SessionRow {
  username: string;
  type: number;
  unread_count: number;
  summary: string | null;
  draft: string | null;
  last_timestamp: number;
  sort_timestamp: number;
  last_msg_sender: string | null;
  last_sender_display_name: string | null;
  is_hidden: number;
}

interface ContactRow {
  username: string;
  nick_name: string | null;
  remark: string | null;
  alias: string | null;
  small_head_url: string | null;
  local_type: number;
}

/**
 * List chats by querying WeChat's session.db and contact.db.
 *
 * @param accountDir - WeChat account directory name
 * @param keys - Map of db names to hex keys
 * @param limit - Max chats to return (default 50)
 */
export function listChatsFromWechatDb(
  accountDir: string,
  keys: Record<string, string>,
  limit: number = 50,
  offset: number = 0
): Chat[] {
  const sessionKey = keys["session.db"];
  const contactKey = keys["contact.db"];

  if (!sessionKey || !contactKey) {
    return [];
  }

  const sessionDbPath = getDbPath(accountDir, "session.db");
  const contactDbPath = getDbPath(accountDir, "contact.db");

  // Get active sessions ordered by sort_timestamp
  const sessions = queryWechatDb(
    sessionDbPath,
    sessionKey,
    `SELECT username, type, unread_count, summary, draft, last_timestamp,
            sort_timestamp, last_msg_sender, last_sender_display_name, is_hidden
     FROM SessionTable
     WHERE is_hidden = 0
     ORDER BY sort_timestamp DESC
     LIMIT ${limit} OFFSET ${offset};`
  ) as unknown as SessionRow[];

  if (sessions.length === 0) return [];

  // Get all usernames we need to resolve
  const usernames = sessions.map(s => s.username);

  // Batch lookup contacts
  const contactMap = new Map<string, ContactRow>();
  // Query in chunks to avoid SQL length limits
  const chunkSize = 50;
  for (let i = 0; i < usernames.length; i += chunkSize) {
    const chunk = usernames.slice(i, i + chunkSize);
    const placeholders = chunk.map(u => `'${u.replace(/'/g, "''")}'`).join(",");
    const contacts = queryWechatDb(
      contactDbPath,
      contactKey,
      `SELECT username, nick_name, remark, alias, small_head_url, local_type
       FROM contact
       WHERE username IN (${placeholders});`
    ) as unknown as ContactRow[];

    for (const c of contacts) {
      contactMap.set(c.username, c);
    }
  }

  // Build chat list
  return sessions.map((session): Chat => {
    const contact = contactMap.get(session.username);
    const isGroup = session.username.includes("@chatroom");

    // Name resolution: remark > nick_name > username
    const name = contact?.remark || contact?.nick_name || session.username;

    return {
      id: session.username,
      username: session.username,
      name,
      remark: contact?.remark || undefined,
      unreadCount: session.unread_count ?? 0,
      isGroup,
      lastMessagePreview: session.summary || undefined,
      lastMessageSender: session.last_sender_display_name || session.last_msg_sender || undefined,
      lastActivityAt: session.last_timestamp
        ? new Date(session.last_timestamp * 1000).toISOString()
        : undefined,
    };
  });
}

/**
 * Find a chat by WeChat username (exact match).
 */
export function getChatByUsername(
  accountDir: string,
  keys: Record<string, string>,
  username: string
): Chat | null {
  const sessionKey = keys["session.db"];
  const contactKey = keys["contact.db"];

  if (!sessionKey || !contactKey) return null;

  const sessionDbPath = getDbPath(accountDir, "session.db");
  const contactDbPath = getDbPath(accountDir, "contact.db");

  const sessions = queryWechatDb(
    sessionDbPath,
    sessionKey,
    `SELECT username, type, unread_count, summary, draft, last_timestamp,
            sort_timestamp, last_msg_sender, last_sender_display_name, is_hidden
     FROM SessionTable
     WHERE username = '${username.replace(/'/g, "''")}';`
  ) as unknown as SessionRow[];

  if (sessions.length === 0) return null;
  const session = sessions[0];

  const contacts = queryWechatDb(
    contactDbPath,
    contactKey,
    `SELECT username, nick_name, remark, alias, small_head_url, local_type
     FROM contact
     WHERE username = '${username.replace(/'/g, "''")}';`
  ) as unknown as ContactRow[];

  const contact = contacts[0] || null;
  const isGroup = session.username.includes("@chatroom");
  const name = contact?.remark || contact?.nick_name || session.username;

  return {
    id: session.username,
    username: session.username,
    name,
    remark: contact?.remark || undefined,
    unreadCount: session.unread_count ?? 0,
    isGroup,
    lastMessagePreview: session.summary || undefined,
    lastMessageSender: session.last_sender_display_name || session.last_msg_sender || undefined,
    lastActivityAt: session.last_timestamp
      ? new Date(session.last_timestamp * 1000).toISOString()
      : undefined,
  };
}

/**
 * Find chats by name (partial match on nick_name, remark, or username).
 */
export function findChatsByName(
  accountDir: string,
  keys: Record<string, string>,
  query: string
): Chat[] {
  const contactKey = keys["contact.db"];
  const sessionKey = keys["session.db"];

  if (!contactKey || !sessionKey) return [];

  const contactDbPath = getDbPath(accountDir, "contact.db");
  const sessionDbPath = getDbPath(accountDir, "session.db");

  const escaped = query.replace(/'/g, "''");

  // Search contacts by name/remark
  const contacts = queryWechatDb(
    contactDbPath,
    contactKey,
    `SELECT username, nick_name, remark, alias, small_head_url, local_type
     FROM contact
     WHERE nick_name LIKE '%${escaped}%'
        OR remark LIKE '%${escaped}%'
        OR username LIKE '%${escaped}%'
     LIMIT 20;`
  ) as unknown as ContactRow[];

  if (contacts.length === 0) return [];

  // Get session info for matched contacts
  const usernames = contacts.map(c => `'${c.username.replace(/'/g, "''")}'`).join(",");
  const sessions = queryWechatDb(
    sessionDbPath,
    sessionKey,
    `SELECT username, type, unread_count, summary, draft, last_timestamp,
            sort_timestamp, last_msg_sender, last_sender_display_name, is_hidden
     FROM SessionTable
     WHERE username IN (${usernames})
     ORDER BY sort_timestamp DESC;`
  ) as unknown as SessionRow[];

  const sessionMap = new Map<string, SessionRow>();
  for (const s of sessions) {
    sessionMap.set(s.username, s);
  }

  return contacts
    .filter(c => sessionMap.has(c.username))
    .map((contact): Chat => {
      const session = sessionMap.get(contact.username)!;
      const isGroup = contact.username.includes("@chatroom");
      const name = contact.remark || contact.nick_name || contact.username;

      return {
        id: session.username,
        username: session.username,
        name,
        remark: contact.remark || undefined,
        unreadCount: session.unread_count ?? 0,
        isGroup,
        lastMessagePreview: session.summary || undefined,
        lastMessageSender: session.last_sender_display_name || session.last_msg_sender || undefined,
        lastActivityAt: session.last_timestamp
          ? new Date(session.last_timestamp * 1000).toISOString()
          : undefined,
      };
    });
}
