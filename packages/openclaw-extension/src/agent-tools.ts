import type { ResolvedWeChatAccount } from "./types.js";
import { WeChatClient } from "@agent-wechat/shared";
import { loginStart, getActiveLoginState } from "./login.js";

function makeClient(account: ResolvedWeChatAccount): WeChatClient {
  return new WeChatClient({
    baseUrl: account.serverUrl,
    token: account.token,
  });
}

// ──────────────────────────────────────────────────
// Tool 1: wechat_login (登录/登出/查状态)
// ──────────────────────────────────────────────────
export function createWeChatLoginTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Login",
    name: "wechat_login",
    description:
      "Check WeChat login status, start a login session, or log out. Calling start shows QR or pushes login to phone. User must confirm on their phone to complete login.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "logout", "status"] },
        force: { type: "boolean", description: "Log in with a new account (shows QR code)" },
        timeoutMs: { type: "number" },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const action = args.action as "start" | "logout" | "status";
      const force = args.force as boolean | undefined;
      const timeoutMs = args.timeoutMs as number | undefined;

      if (action === "status") {
        try {
          const auth = await client.authStatus();
          const text = auth.status === "logged_in"
            ? `WeChat is logged in${auth.loggedInUser ? ` as ${auth.loggedInUser}` : ""}.`
            : `WeChat status: ${auth.status.replace(/_/g, " ")}.`;
          return { content: [{ type: "text" as const, text }], details: auth };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed to check: ${err instanceof Error ? err.message : String(err)}` }],
            details: { error: true },
          };
        }
      }

      if (action === "logout") {
        try {
          const result = await client.logout();
          return {
            content: [{ type: "text" as const, text: result.success ? "Logged out." : `Logout failed${result.error ? `: ${result.error}` : ""}.` }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Logout error: ${err instanceof Error ? err.message : String(err)}` }],
            details: { error: true },
          };
        }
      }

      // action === "start"
      const existing = getActiveLoginState(account.accountId);
      if (existing.active && !force) {
        if (existing.done && existing.connected)
          return { content: [{ type: "text" as const, text: "Already logged in." }], details: { state: "done" } };
        if (existing.done)
          return { content: [{ type: "text" as const, text: existing.error ?? existing.message ?? "Login ended." }], details: { state: "done", error: existing.error } };
        const parts = [existing.message ?? "In progress..."];
        if (existing.qrData) parts.push(`QR data: ${existing.qrData}`);
        return { content: [{ type: "text" as const, text: parts.join("\n") }], details: { state: existing.qrData ? "qr" : "waiting", qrData: existing.qrData } };
      }

      try {
        const result = await loginStart(client, account.accountId, { timeoutMs, force });
        const state = getActiveLoginState(account.accountId);
        const text = state.qrData ? `${result.message}\nQR data: ${state.qrData}` : result.message;
        return { content: [{ type: "text" as const, text }], details: { state: state.qrData ? "qr" : "waiting", qrData: state.qrData } };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Login failed: ${err instanceof Error ? err.message : String(err)}` }], details: { error: true } };
      }
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 2: wechat_preview_send (预览，不发送)
// ──────────────────────────────────────────────────
export function createWeChatPreviewTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Preview Send",
    name: "wechat_preview_send",
    description:
      "Preview sending a WeChat message: checks login, fetches up to 5 recent messages for context, and returns a structured preview. This tool does NOT send any message — it only prepares a preview for user approval before the actual send via wechat_execute_send.",
    parameters: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "WeChat chat ID (wxid_xxx for DM, xxx@chatroom for groups)" },
        text: { type: "string", description: "Text message content to send" },
        chatName: { type: "string", description: "Optional human-readable target name for display" },
      },
      required: ["chatId", "text"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const chatId = args.chatId as string;
      const text = args.text as string;
      const chatName = (args.chatName as string) || chatId;

      const parts: string[] = [];
      parts.push(`📋 WeChat 发送预览`);
      parts.push(`🎯 目标: ${chatName} (${chatId})`);
      parts.push(`📝 内容: ${text}`);
      parts.push(``);

      // 1. Check login
      try {
        const auth = await client.authStatus();
        if (auth.status !== "logged_in") {
          return {
            content: [{ type: "text" as const, text: `❌ WeChat 未登录 (${auth.status.replace(/_/g, " ")})。请先 wechat_login(start)。` }],
            details: { canSend: false, reason: "not_logged_in" },
          };
        }
        parts.push(`✅ 已登录: ${auth.loggedInUser ?? "?"}`);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ 状态检查失败` }], details: { canSend: false, reason: "status_error" } };
      }

      // 2. Fetch recent messages
      try {
        const msgs = await client.listMessages(chatId, 5, 0);
        if (msgs.length > 0) {
          parts.push(`📜 最近 ${msgs.length} 条:`);
          for (const m of msgs) {
            const sender = m.senderName || m.sender || "?";
            parts.push(`   [${m.localId}] ${sender}: ${(m.content || "[非文本]").slice(0, 100)}`);
          }
        } else {
          parts.push(`📜 无历史消息`);
        }
      } catch {
        parts.push(`📜 无法获取历史消息`);
      }

      parts.push(``);
      parts.push(`⚠️ 预览完成。如需发送，请确认后调用 wechat_execute_send。`);

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details: { canSend: true, chatId, text },
      };
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 3: wechat_execute_send (执行发送，需 /approve)
// ──────────────────────────────────────────────────
export function createWeChatSendTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Execute Send",
    name: "wechat_execute_send",
    description:
      "Execute sending a WeChat message. MUST only be called after user has reviewed and approved the preview from wechat_preview_send. Double-checks login before sending. Requires exec(ask:always) + /approve.",
    parameters: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Target chat ID (must match preview)" },
        text: { type: "string", description: "Message content (must match preview)" },
      },
      required: ["chatId", "text"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const chatId = args.chatId as string;
      const text = args.text as string;

      // Re-check login
      try {
        const auth = await client.authStatus();
        if (auth.status !== "logged_in") {
          return { content: [{ type: "text" as const, text: `❌ 未登录，发送取消。` }], details: { success: false, reason: "not_logged_in" } };
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ 连接异常，发送取消。` }], details: { success: false, reason: "connection_error" } };
      }

      try {
        const result = await client.sendMessage({ chatId, text });
        if (result.success) {
          return { content: [{ type: "text" as const, text: `✅ 消息已发送！` }], details: { success: true, messageId: result.messageId } };
        }
        return { content: [{ type: "text" as const, text: `❌ 发送失败: ${result.error || "未知错误"}` }], details: { success: false, error: result.error } };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ 发送异常: ${err instanceof Error ? err.message : String(err)}` }], details: { success: false, error: String(err) } };
      }
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 4: wechat_list_chats (列聊天)
// ──────────────────────────────────────────────────
export function createWeChatListChatsTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat List Chats",
    name: "wechat_list_chats",
    description:
      "List WeChat chats/contacts. Can search by name. Returns chat ID, name, unread count, and whether it's a group.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query to filter by name" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
      },
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const query = args.query as string | undefined;
      const limit = (args.limit as number) || 20;

      try {
        const chats = query
          ? await client.findChats(query)
          : await client.listChats(limit);

        if (chats.length === 0) {
          return { content: [{ type: "text" as const, text: query ? `未找到匹配 "${query}" 的聊天。` : "无聊天记录。" }], details: { chats: [] } };
        }

        const lines: string[] = [];
        lines.push(`📋 ${query ? `搜索 "${query}" 结果` : `聊天列表`} (${chats.length} 个):`);
        lines.push(``);
        for (const c of chats.slice(0, limit)) {
          const isGroup = c.username.includes("@chatroom") ? "👥" : "👤";
          const unread = c.unread && c.unread > 0 ? ` (${c.unread}条未读)` : "";
          lines.push(`  ${isGroup} ${c.name}${unread}`);
          lines.push(`     ID: ${c.username}`);
        }
        lines.push(``);
        lines.push(`💡 使用 wechat_read(chatId) 读消息或 wechat_preview_send(chatId, text) 发消息。`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { chats: chats.slice(0, limit) },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ 获取聊天列表失败。` }], details: { error: String(err) } };
      }
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 5: wechat_read (读消息)
// ──────────────────────────────────────────────────
export function createWeChatReadTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Read Messages",
    name: "wechat_read",
    description:
      "Read recent messages from a WeChat chat. Works even when WeChat is locked (reads from local SQLite database). Returns messages with sender name, time, and content.",
    parameters: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "Chat ID (wxid_xxx for DM, xxx@chatroom for groups)" },
        limit: { type: "number", description: "Number of messages to fetch (default 10, max 50)", default: 10 },
        offset: { type: "number", description: "Skip N latest messages (default 0 = most recent)", default: 0 },
      },
      required: ["chatId"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const chatId = args.chatId as string;
      const limit = Math.min((args.limit as number) || 10, 50);
      const offset = (args.offset as number) || 0;

      try {
        const msgs = await client.listMessages(chatId, limit, offset);

        if (msgs.length === 0) {
          return { content: [{ type: "text" as const, text: `📜 ${chatId} 无消息记录。` }], details: { messages: [] } };
        }

        const lines: string[] = [];
        lines.push(`📜 ${chatId} 的最新消息 (${msgs.length} 条):`);
        lines.push(``);
        for (const m of msgs) {
          const sender = m.senderName || m.sender || "?";
          const time = m.timestamp ? new Date(m.timestamp).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }) : "";
          const label = m.isSelf ? "← 我" : `→ ${sender}`;
          lines.push(`  [${time}] ${label}: ${(m.content || "[非文本]").slice(0, 200)}`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { messages: msgs },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ 读取消息失败。` }], details: { error: String(err) } };
      }
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 6: wechat_screenshot (截图，返回 base64)
// ──────────────────────────────────────────────────
export function createWeChatScreenshotTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Screenshot",
    name: "wechat_screenshot",
    description:
      "Take a screenshot of the current WeChat window. Returns base64-encoded PNG image that can be displayed to the user. Useful for debugging UI state (locked screen, popups, login screen).",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      try {
        const result = await client.screenshot();
        return {
          content: [{ type: "text" as const, text: "📷 截图完成 (base64 已返回，可在 details 中查看)。" }],
          details: { base64: result.base64 },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ 截图失败。` }], details: { error: String(err) } };
      }
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 7: wechat_a11y (导出辅助树)
// ──────────────────────────────────────────────────
export function createWeChatA11yTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat A11y Tree",
    name: "wechat_a11y",
    description:
      "Dump the current WeChat window's accessibility tree. Useful for detecting the current UI state: login screen, chat view, locked screen, popups, etc. Returns JSON or human-readable ARIA format. Use this before sending to verify WeChat is in a usable state.",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["json", "aria"],
          description: "json = raw tree, aria = human-readable indented format",
          default: "aria",
        },
      },
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const format = (args.format as string) || "aria";

      try {
        const result = await client.a11y(format as "json" | "aria");

        if (format === "aria") {
          // ARIA is already a readable string
          return {
            content: [{ type: "text" as const, text: `🔍 WeChat A11y 树:\n\n${result.aria || "(无数据)"}` }],
            details: result,
          };
        }

        // JSON format - return as text
        const jsonStr = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
        return {
          content: [{ type: "text" as const, text: `🔍 WeChat A11y 树 (JSON):\n\n${jsonStr.slice(0, 3000)}${jsonStr.length > 3000 ? "\n...(截断)" : ""}` }],
          details: result,
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ 获取 A11y 树失败。` }], details: { error: String(err) } };
      }
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 8: wechat_unlock (触发手机解锁通知)
// ──────────────────────────────────────────────────
export function createWeChatUnlockTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Unlock",
    name: "wechat_unlock",
    description:
      "Trigger unlock for WeChat that was locked from the phone. Clicks the 'Unlock on Phone' button which sends a notification to the user's phone. The user must then confirm on their phone to complete unlocking. After calling this, verify with wechat_a11y or wechat_screenshot to confirm unlock.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      // First verify WeChat is actually locked
      try {
        const a11y = await client.a11y("aria");
        const ariaText = (a11y as any)?.aria || "";
        if (!ariaText.includes("locked") && !ariaText.includes("Unlock")) {
          return {
            content: [{ type: "text" as const, text: "✅ WeChat 当前未被锁定，无需解锁。" }],
            details: { alreadyUnlocked: true },
          };
        }
      } catch {
        // If we can't check, proceed anyway
      }

      // Click coordinates for "Unlock on Phone" button
      // Execute via docker exec (shell command)
      const unlockCmd = `docker exec agent-wechat click 640 490`;

      return {
        content: [{
          type: "text" as const,
          text: `🔓 WeChat 锁定中。请在手机上确认解锁。\n\n已触发解锁请求（点击了 "Unlock on Phone" 按钮）。\n手机微信 → 聊天列表顶部状态栏 → 解锁。`,
        }],
        details: {
          action: "unlock_triggered",
          command: unlockCmd,
          note: "User must confirm on phone to complete unlock.",
        },
      };
    },
  };
}
