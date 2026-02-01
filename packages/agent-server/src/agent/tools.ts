import { tool } from "ai";
import { z } from "zod";
import { execCommand } from "../lib/exec.js";
import fs from "fs/promises";
import path from "path";

/**
 * Allowed command prefixes - only these commands can be executed
 * This prevents prompt injection from WeChat content
 */
const ALLOWED_COMMANDS = [
  "wechat-screenshot",
  "wechat-a11y",
  "wechat-click",
  "wechat-type",
  "wechat-key",
  "wechat-scroll",
  "wechat-notifications",
  "db-list-chats",
  "db-get-chat",
  "db-find-chat",
  "db-upsert-chat",
  "db-update-chat",
  "db-list-messages",
  "db-get-message",
  "db-upsert-message",
  "db-mark-chat-read",
  "db-get-sync",
  "db-set-sync",
];

/**
 * Parse a command string into command and arguments
 * Returns null if the command is not allowed
 */
function parseCommand(commandLine: string): { command: string; args: string[] } | null {
  const trimmed = commandLine.trim();

  // Find which allowed command this starts with
  const matchedCommand = ALLOWED_COMMANDS.find(cmd =>
    trimmed === cmd || trimmed.startsWith(cmd + " ")
  );

  if (!matchedCommand) {
    return null;
  }

  // Extract arguments after the command
  const argsString = trimmed.slice(matchedCommand.length).trim();

  // Simple argument parsing (handles quoted strings)
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " ") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return { command: matchedCommand, args };
}

/**
 * Command descriptions for the LLM
 */
const COMMAND_HELP = `
Available commands:

## UI Observation

wechat-screenshot
  Take a screenshot of the WeChat window.
  Returns: base64-encoded PNG image data
  Example: wechat-screenshot

wechat-a11y --scope <scope>
  Get accessibility tree information from the UI.
  Scopes: chats, messages, buttons, full (WeChat only), desktop (all windows)
  Returns: JSON with items array containing element info and bounds (x, y, width, height in pixels)
  Example: wechat-a11y --scope chats
  Example: wechat-a11y --scope desktop

## UI Interaction

wechat-click <x> <y>
  Click at screen coordinates.
  Use bounds from wechat-a11y to find targets.
  To click center: x = bounds.x + bounds.width/2, y = bounds.y + bounds.height/2
  Example: wechat-click 150 300

wechat-type "<text>"
  Type text into the focused input field.
  Works with Unicode (Chinese, emoji, etc.)
  Example: wechat-type "你好"
  Example: wechat-type "Hello world"

wechat-key <combo>
  Press a key or key combination.
  Example: wechat-key Return
  Example: wechat-key ctrl+a
  Example: wechat-key Escape

wechat-scroll <direction> [amount]
  Scroll up or down. Amount defaults to 3.
  Example: wechat-scroll up
  Example: wechat-scroll down 5

## Database - Chats

db-list-chats [--limit N] [--unread-only]
  List chats from database.
  Example: db-list-chats --limit 20
  Example: db-list-chats --unread-only

db-get-chat --id <id>
  Get a specific chat by ID.
  Example: db-get-chat --id "abc123"

db-find-chat --name "<name>"
  Find chats by name (fuzzy search).
  Example: db-find-chat --name "张三"

db-upsert-chat --id <id> --name <name> [--unread N] [--preview "..."] [--sender "..."] [--is-group] [--is-pinned]
  Create or update a chat.
  Example: db-upsert-chat --id "abc123" --name "张三" --unread 2 --preview "你好"

db-update-chat --id <id> [--name "..."] [--unread N] [--scroll-hint N]
  Update specific fields of a chat.
  Example: db-update-chat --id "abc123" --unread 0

db-mark-chat-read --chat-id <id>
  Mark a chat as read (set unread_count to 0).
  Example: db-mark-chat-read --chat-id "abc123"

## Database - Messages

db-list-messages --chat-id <id> [--limit N] [--since <timestamp>]
  List messages for a chat.
  Example: db-list-messages --chat-id "abc123" --limit 20

db-get-message --id <id>
  Get a specific message.
  Example: db-get-message --id "msg456"

db-upsert-message --id <id> --chat-id <id> --type <type> [--text "..."] [--sender "..."] [--outgoing] [--time-display "..."]
  Create or update a message.
  Types: text, image, video, file, audio, sticker, link, miniprogram, location
  Example: db-upsert-message --id "msg456" --chat-id "abc123" --type text --text "Hello" --sender "张三"

## Database - Sync State

db-get-sync <key>
  Get a sync state value.
  Example: db-get-sync "last_chat_list_sync"

db-set-sync <key> <value>
  Set a sync state value.
  Example: db-set-sync "last_chat_list_sync" "2024-01-15T10:30:00Z"
`;

const bashInputSchema = z.object({
  command: z.string().describe("The command to execute"),
});

/**
 * Bash tool - executes allowed commands only
 */
export const bash = tool({
  description: `Execute a command. Only the following commands are available:
${COMMAND_HELP}`,
  inputSchema: bashInputSchema,
  execute: async ({ command }: z.infer<typeof bashInputSchema>) => {
    const parsed = parseCommand(command);

    if (!parsed) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Command not allowed. Only these commands are available: ${ALLOWED_COMMANDS.join(", ")}`,
      };
    }

    try {
      const result = await execCommand(parsed.command, parsed.args);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: String(error),
      };
    }
  },
});

const readFileInputSchema = z.object({
  path: z.string().describe("Path to the file to read"),
});

/**
 * ReadFile tool - reads files including images
 * Returns base64 data for binary files, text for text files
 */
export const readFile = tool({
  description: `Read a file from the filesystem.
For images (png, jpg, gif, webp), returns base64 data that will be displayed.
For text files, returns the text content.
Use this to view screenshots taken with wechat-screenshot.`,
  inputSchema: readFileInputSchema,
  execute: async ({ path: filePath }: z.infer<typeof readFileInputSchema>) => {
    try {
      // Validate path - only allow reading from safe directories
      const resolved = path.resolve(filePath);
      const allowedPrefixes = ["/tmp", "/data", "/home/wechat"];

      if (!allowedPrefixes.some(prefix => resolved.startsWith(prefix))) {
        return {
          success: false,
          error: `Cannot read from this path. Allowed directories: ${allowedPrefixes.join(", ")}`,
        };
      }

      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return { success: false, error: "Path is not a file" };
      }

      // Check file extension to determine how to read
      const ext = path.extname(resolved).toLowerCase();
      const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

      if (imageExtensions.includes(ext)) {
        // Read as base64 for images
        const buffer = await fs.readFile(resolved);
        const base64 = buffer.toString("base64");
        const mimeType = ext === ".png" ? "image/png"
          : ext === ".gif" ? "image/gif"
          : ext === ".webp" ? "image/webp"
          : "image/jpeg";

        return {
          success: true,
          type: "image",
          mimeType,
          data: base64,
        };
      } else {
        // Read as text
        const content = await fs.readFile(resolved, "utf-8");
        return {
          success: true,
          type: "text",
          content,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  },
});

/**
 * All tools available to the agent
 */
export const allTools = {
  bash,
  readFile,
};

export type WechatTools = typeof allTools;
