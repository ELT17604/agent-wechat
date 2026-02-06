import type { A11yNode, Bounds } from "./types.js";
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
