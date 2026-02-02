import type { A11yNode, Chat, Message, Bounds } from "./types.js";
import { querySelector } from "./selectors.js";

/**
 * Generate a stable hash from a string.
 */
function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Parse a chat from a11y list item.
 *
 * WeChat format: "Name [N unread message(s)] [Sender:] Preview Time [Muted] [Pinned]"
 */
export function parseChat(item: A11yNode): Chat {
  const raw = item.name ?? "";

  // Extract muted status
  const muted = /Mute Notif/i.test(raw);
  let text = raw.replace(/\s*Mute Notif\w*\s*$/i, "");

  // Extract time (HH:MM at end)
  const timeMatch = text.match(/\s(\d{1,2}:\d{2})\s*$/);
  const lastMessageTime = timeMatch ? timeMatch[1] : undefined;
  if (timeMatch) {
    text = text.slice(0, timeMatch.index).trim();
  }

  // Extract pinned status
  const pinned = text.includes("Stuck on Top");
  text = text.replace("Stuck on Top", "").trim();

  // Extract unread count and parse name/preview
  let name = "";
  let unreadCount = 0;
  let lastMessagePreview: string | undefined;
  let lastMessageSender: string | undefined;

  const unreadMatch = text.match(/^(.+?)\s+(\d+)\s+unread message\(s\)\s*(.*)$/);
  if (unreadMatch) {
    name = unreadMatch[1].trim();
    unreadCount = parseInt(unreadMatch[2]);
    let remainder = unreadMatch[3].trim();
    // Remove [N] prefix if present
    remainder = remainder.replace(/^\[\d+\]\s*/, "");

    // Check for sender: message format
    const senderMatch = remainder.match(/^([^:]+):\s*(.+)$/);
    if (senderMatch) {
      lastMessageSender = senderMatch[1].trim();
      lastMessagePreview = senderMatch[2].trim();
    } else if (remainder) {
      lastMessagePreview = remainder;
    }
  } else {
    // No unread, check for sender: message
    const colonMatch = text.match(/^(.+?)\s+([^:\s]+):\s*(.+)$/);
    if (colonMatch) {
      name = colonMatch[1].trim();
      lastMessageSender = colonMatch[2].trim();
      lastMessagePreview = colonMatch[3].trim();
    } else {
      name = text.trim();
    }
  }

  return {
    id: `chat_${hashString(raw)}`,
    name,
    unreadCount,
    lastMessagePreview,
    lastMessageTime,
    lastMessageSender,
    pinned,
    muted,
    bounds: item.bounds,
  };
}

/**
 * Parse a message from a11y list item.
 */
export function parseMessage(item: A11yNode, chatId?: string): Message {
  const raw = item.name ?? "";
  const isTimestamp = /^\d{1,2}:\d{2}$/.test(raw.trim());

  return {
    id: `msg_${hashString(raw + (item.bounds?.y ?? 0))}`,
    chatId,
    content: raw,
    type: isTimestamp ? "timestamp" : "text",
    outgoing: false, // TODO: detect from position or styling
    bounds: item.bounds,
  };
}

/**
 * Extract active chat ID from message view header.
 */
export function extractActiveChatId(a11y: A11yNode): string | null {
  // Look for chat name in the header area
  // This is a heuristic - may need adjustment based on actual UI structure
  const header = querySelector(a11y, 'label[name=/.+/]');
  if (header?.name) {
    return `chat_${hashString(header.name)}`;
  }
  return null;
}

/**
 * Check if bounds are valid (non-zero size).
 */
export function hasValidBounds(bounds?: Bounds): boolean {
  if (!bounds) return false;
  return bounds.width > 0 && bounds.height > 0;
}

/**
 * Calculate center point of bounds.
 */
export function getBoundsCenter(bounds: Bounds): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}
