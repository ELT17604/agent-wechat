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
// Tool 1: wechat_login (existing)
// ──────────────────────────────────────────────────
export function createWeChatLoginTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Login",
    name: "wechat_login",
    description:
      "Check WeChat login status, start a login session, or log out. Calling start again returns the latest state from the existing session. When start returns qrData, generate a QR code image from it and show it to the user so they can scan it with their phone.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "logout", "status"],
        },
        force: {
          type: "boolean",
          description:
            "Log in with a new account (shows QR code even if already logged in)",
        },
        timeoutMs: { type: "number" },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const action = args.action as "start" | "logout" | "status";
      const force = args.force as boolean | undefined;
      const timeoutMs = args.timeoutMs as number | undefined;

      switch (action) {
        case "status": {
          try {
            const auth = await client.authStatus();
            const text =
              auth.status === "logged_in"
                ? `WeChat is logged in${auth.loggedInUser ? ` as ${auth.loggedInUser}` : ""}.`
                : `WeChat status: ${auth.status.replace(/_/g, " ")}.`;
            return {
              content: [{ type: "text" as const, text }],
              details: auth,
            };
          } catch (err) {
            const text = `Failed to check WeChat status: ${err instanceof Error ? err.message : String(err)}`;
            return {
              content: [{ type: "text" as const, text }],
              details: { error: true },
            };
          }
        }

        case "start": {
          const existing = getActiveLoginState(account.accountId);
          if (existing.active && !force) {
            if (existing.done && existing.connected) {
              return {
                content: [{ type: "text" as const, text: "Login successful." }],
                details: { state: "done", connected: true },
              };
            }
            if (existing.done) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: existing.error ?? existing.message ?? "Login session ended.",
                  },
                ],
                details: { state: "done", connected: false, error: existing.error },
              };
            }
            const parts: string[] = [];
            if (existing.message) parts.push(existing.message);
            if (existing.qrData) parts.push(`QR data: ${existing.qrData}`);
            return {
              content: [{ type: "text" as const, text: parts.join("\n") || "Login in progress..." }],
              details: { state: existing.qrData ? "qr" : "waiting", qrData: existing.qrData },
            };
          }

          try {
            const result = await loginStart(client, account.accountId, { timeoutMs, force });
            const state = getActiveLoginState(account.accountId);
            if (state.qrData) {
              return {
                content: [{ type: "text" as const, text: `${result.message}\nQR data: ${state.qrData}` }],
                details: { state: "qr", qrData: state.qrData },
              };
            }
            return {
              content: [{ type: "text" as const, text: result.message }],
              details: { state: "waiting" },
            };
          } catch (err) {
            const text = `Failed to start WeChat login: ${err instanceof Error ? err.message : String(err)}`;
            return { content: [{ type: "text" as const, text }], details: { error: true } };
          }
        }

        case "logout": {
          try {
            const result = await client.logout();
            const text = result.success
              ? "WeChat logged out successfully."
              : `WeChat logout failed${result.error ? `: ${result.error}` : ""}.`;
            return { content: [{ type: "text" as const, text }], details: result };
          } catch (err) {
            const text = `Failed to log out of WeChat: ${err instanceof Error ? err.message : String(err)}`;
            return { content: [{ type: "text" as const, text }], details: { error: true } };
          }
        }
      }
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 2: wechat_preview_send
//   Shows target, message content, and recent context.
//   DOES NOT send — only previews for human approval.
// ──────────────────────────────────────────────────
export function createWeChatPreviewTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Preview Send",
    name: "wechat_preview_send",
    description:
      "Preview sending a WeChat message: checks login, fetches up to 5 recent messages for context, and returns a preview. This tool does NOT send any message — it only prepares a preview for the user to approve before the actual send.",
    parameters: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          description: "WeChat chat ID (wxid_xxx for direct messages, xxx@chatroom for groups)",
        },
        text: {
          type: "string",
          description: "Text message content to send",
        },
        chatName: {
          type: "string",
          description: "Optional human-readable name of the target chat (for display)",
        },
      },
      required: ["chatId", "text"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const chatId = args.chatId as string;
      const text = args.text as string;
      const chatName = (args.chatName as string) || chatId;

      const results: string[] = [];
      results.push(`📋 WeChat 发送预览`);
      results.push(`───`);
      results.push(`🎯 目标: ${chatName} (${chatId})`);
      results.push(`📝 内容: ${text}`);
      results.push(``);

      // Check login status
      try {
        const auth = await client.authStatus();
        if (auth.status !== "logged_in") {
          return {
            content: [{ type: "text" as const, text: `❌ WeChat 未登录。当前状态: ${auth.status.replace(/_/g, " ")}。请先使用 wechat_login tool 登录。` }],
            details: { canSend: false, reason: "not_logged_in", auth },
          };
        }
        results.push(`✅ 登录状态: 已登录${auth.loggedInUser ? ` (${auth.loggedInUser})` : ""}`);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ 无法检测 WeChat 状态: ${err instanceof Error ? err.message : String(err)}` }],
          details: { canSend: false, reason: "status_check_failed" },
        };
      }

      // Fetch recent messages for context
      try {
        const messages = await client.listMessages(chatId, 5, 0);
        if (messages.length > 0) {
          results.push(`📜 最近 ${messages.length} 条消息:`);
          for (const m of messages) {
            const sender = m.senderName || m.sender || "?";
            const msgText = (m.content || "[非文本消息]").slice(0, 100);
            results.push(`   [${m.localId}] ${sender}: ${msgText}`);
          }
        } else {
          results.push(`📜 该聊天无历史消息（或无法读取历史）`);
        }
      } catch {
        results.push(`📜 无法获取最近消息（可能聊天 ID 无效或无权限）`);
      }

      results.push(``);
      results.push(`⚠️ 预览完成。如需发送，请确认后调用 wechat_execute_send。`);

      return {
        content: [{ type: "text" as const, text: results.join("\n") }],
        details: { canSend: true, chatId, text },
      };
    },
  };
}

// ──────────────────────────────────────────────────
// Tool 3: wechat_execute_send
//   Actually sends the message. Must be called AFTER
//   wechat_preview_send and user approval.
// ──────────────────────────────────────────────────
export function createWeChatSendTool(account: ResolvedWeChatAccount) {
  const client = makeClient(account);

  return {
    label: "WeChat Execute Send",
    name: "wechat_execute_send",
    description:
      "Execute sending a WeChat message. This tool actually sends the message. MUST only be called after the user has reviewed and approved the preview from wechat_preview_send. Returns send result.",
    parameters: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          description: "WeChat chat ID (must match the ID used in wechat_preview_send)",
        },
        text: {
          type: "string",
          description: "Text message content to send (must match preview)",
        },
      },
      required: ["chatId", "text"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const chatId = args.chatId as string;
      const text = args.text as string;

      // Double-check login before sending
      try {
        const auth = await client.authStatus();
        if (auth.status !== "logged_in") {
          return {
            content: [{ type: "text" as const, text: `❌ WeChat 未登录（当前: ${auth.status.replace(/_/g, " ")})。发送取消。` }],
            details: { success: false, reason: "not_logged_in" },
          };
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ WeChat 连接异常，发送取消: ${err instanceof Error ? err.message : String(err)}` }],
          details: { success: false, reason: "connection_error" },
        };
      }

      // Send message
      try {
        const result = await client.sendMessage({
          chatId,
          text,
        });

        if (result.success) {
          return {
            content: [{ type: "text" as const, text: `✅ 消息已发送成功！目标: ${chatId}` }],
            details: { success: true, messageId: result.messageId },
          };
        }

        // Handle known error types
        if (result.error === "NOT_LOGGED_IN") {
          return {
            content: [{ type: "text" as const, text: `❌ 发送失败：WeChat 未登录。请使用 wechat_login 登录。` }],
            details: { success: false, reason: "not_logged_in", error: result.error },
          };
        }

        return {
          content: [{ type: "text" as const, text: `❌ 发送失败：${result.error || "未知错误"}` }],
          details: { success: false, reason: "send_error", error: result.error },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `❌ 发送异常：${errMsg}` }],
          details: { success: false, reason: "exception", error: errMsg },
        };
      }
    },
  };
}
