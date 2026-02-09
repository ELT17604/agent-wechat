/**
 * Programmatic chat selection via a11y-guided click.
 *
 * Uses the chat-select tool to open a specific chat in the WeChat UI.
 */

import { execCommand, type ExecOptions } from "./exec.js";

interface OpenChatResult {
  ok: boolean;
  username?: string;
  index?: number;
  error?: string;
}

interface ListSessionsResult {
  ok: boolean;
  sessions?: Record<string, number>;
  error?: string;
}

/**
 * Open a chat in the WeChat UI by username.
 *
 * This triggers WeChat to select the chat, which downloads pending media
 * and clears unread counts.
 */
export async function openChat(
  chatId: string,
  options?: ExecOptions
): Promise<OpenChatResult> {
  const result = await execCommand("chat-select", [chatId], {
    ...options,
    timeout: 120_000, // Chat selection can be slow
  });

  // Log stderr (debug output from chat-select.py)
  if (result.stderr) {
    for (const line of result.stderr.split("\n")) {
      if (line.trim()) console.log(line);
    }
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: result.stderr || result.stdout || `chat-select exited with code ${result.exitCode}`,
    };
  }
}

/**
 * List all sessions visible in WeChat's session vector.
 *
 * Returns a map of username -> index in the session list.
 */
export async function listChatSessions(
  options?: ExecOptions
): Promise<ListSessionsResult> {
  const result = await execCommand("chat-select", ["--list"], {
    ...options,
    timeout: 120_000,
  });

  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: result.stderr || result.stdout || `chat-select exited with code ${result.exitCode}`,
    };
  }
}
