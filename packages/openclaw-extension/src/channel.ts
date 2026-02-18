import type { ChannelPlugin, ChannelMeta } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedWeChatAccount } from "./types.js";
import { resolveWeChatAccount } from "./types.js";
import { startWeChatMonitor } from "./monitor.js";
import { wechatOnboardingAdapter } from "./onboarding.js";
import { collectWeChatStatusIssues } from "./status.js";
import { WeChatClient } from "@thisnick/agent-wechat-shared";
import { loginStart, loginWait, loginTerminal } from "./login.js";

const meta: ChannelMeta = {
  id: "wechat",
  label: "WeChat",
  selectionLabel: "WeChat (微信)",
  blurb: "WeChat messaging via agent-wechat container.",
  aliases: ["weixin"],
  order: 80,
};

export const wechatPlugin: ChannelPlugin<ResolvedWeChatAccount> = {
  id: "wechat",
  meta,
  gatewayMethods: ["web.login.start", "web.login.wait"],

  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    reply: true,
  },

  reload: { configPrefixes: ["channels.wechat"] },

  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        serverUrl: { type: "string" },
        dmPolicy: {
          type: "string",
          enum: ["open", "allowlist", "disabled"],
        },
        allowFrom: { type: "array", items: { type: "string" } },
        groupPolicy: {
          type: "string",
          enum: ["open", "allowlist", "disabled"],
        },
        groupAllowFrom: { type: "array", items: { type: "string" } },
        groups: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              requireMention: { type: "boolean" },
            },
          },
        },
        pollIntervalMs: { type: "integer", minimum: 100 },
        authPollIntervalMs: { type: "integer", minimum: 1000 },
      },
    },
  },

  // ---- Config adapter ----
  config: {
    listAccountIds: (_cfg) => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => {
      const account = resolveWeChatAccount(
        cfg as unknown as Record<string, unknown>,
        accountId ?? undefined,
      );
      if (!account) {
        return {
          accountId: accountId ?? DEFAULT_ACCOUNT_ID,
          enabled: false,
          serverUrl: "",
          dmPolicy: "disabled",
          allowFrom: [],
          groupPolicy: "disabled",
          groupAllowFrom: [],
          groups: {},
          pollIntervalMs: 1000,
          authPollIntervalMs: 30000,
        };
      }
      return account;
    },
    isEnabled: (account) => account.enabled && !!account.serverUrl,
    isConfigured: (account) => !!account.serverUrl,
    unconfiguredReason: () =>
      "No serverUrl configured. Run: openclaw channels setup wechat",
  },

  // ---- Security adapter ----
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy ?? "disabled",
      allowFrom: account.allowFrom ?? [],
      allowFromPath: "channels.wechat.allowFrom",
      policyPath: "channels.wechat.dmPolicy",
      approveHint: "Add the wxid to channels.wechat.allowFrom",
    }),
  },

  // ---- Groups adapter ----
  groups: {
    resolveRequireMention: ({ cfg, groupId }) => {
      const wechat = (cfg as any)?.channels?.wechat;
      if (!wechat) return true;
      if (groupId && wechat.groups?.[groupId]?.requireMention != null) {
        return wechat.groups[groupId].requireMention;
      }
      return true; // Default: require mention in groups
    },
  },

  // ---- Messaging adapter ----
  messaging: {
    normalizeTarget: (raw) => raw.replace(/^wechat:/i, "").trim() || undefined,
    targetResolver: {
      looksLikeId: (raw) => {
        const stripped = raw.replace(/^wechat:/i, "").trim();
        return stripped.includes("@chatroom") || stripped.startsWith("wxid_");
      },
      hint: "WeChat ID (wxid_xxx or xxx@chatroom)",
    },
  },

  // ---- Outbound adapter ----
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text }) => {
      const account = resolveWeChatAccount(
        cfg as unknown as Record<string, unknown>,
      );
      if (!account?.serverUrl) {
        return { channel: "wechat", ok: false, error: "No serverUrl configured" };
      }
      const client = new WeChatClient({ baseUrl: account.serverUrl });
      const result = await client.sendMessage({ chatId: to, text });
      return {
        channel: "wechat",
        ok: result.success,
        error: result.error ?? undefined,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl }) => {
      const account = resolveWeChatAccount(
        cfg as unknown as Record<string, unknown>,
      );
      if (!account?.serverUrl) {
        return { channel: "wechat", ok: false, error: "No serverUrl configured" };
      }
      const client = new WeChatClient({ baseUrl: account.serverUrl });
      if (mediaUrl) {
        try {
          let base64: string;
          let mimeType: string;
          if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
            const res = await fetch(mediaUrl);
            const buffer = await res.arrayBuffer();
            base64 = Buffer.from(buffer).toString("base64");
            mimeType = res.headers.get("content-type") ?? "image/png";
          } else {
            // Local file path
            const fs = await import("fs/promises");
            const path = await import("path");
            const buf = await fs.readFile(mediaUrl);
            base64 = buf.toString("base64");
            const ext = path.extname(mediaUrl).toLowerCase().replace(".", "");
            const extMime: Record<string, string> = {
              png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
              gif: "image/gif", webp: "image/webp",
            };
            mimeType = extMime[ext] ?? "image/png";
          }
          const result = await client.sendMessage({
            chatId: to,
            text: text || undefined,
            image: { data: base64, mimeType },
          });
          return {
            channel: "wechat",
            ok: result.success,
            error: result.error ?? undefined,
          };
        } catch (err) {
          return {
            channel: "wechat",
            ok: false,
            error: `Failed to send media: ${err}`,
          };
        }
      }
      // Text-only fallback
      const result = await client.sendMessage({
        chatId: to,
        text: text || undefined,
      });
      return {
        channel: "wechat",
        ok: result.success,
        error: result.error ?? undefined,
      };
    },
  },

  // ---- Gateway adapter ----
  gateway: {
    startAccount: async (ctx) => {
      ctx.log?.info?.(
        `[wechat:${ctx.accountId}] Starting monitor (polling ${ctx.account.serverUrl})`,
      );
      return startWeChatMonitor({
        account: ctx.account,
        abortSignal: ctx.abortSignal,
        runtime: ctx.runtime,
        setStatus: ctx.setStatus,
        log: ctx.log,
        cfg: ctx.cfg,
      });
    },

    loginWithQrStart: async ({ cfg, accountId, force, timeoutMs }: {
      cfg: any;
      accountId: string;
      force?: boolean;
      timeoutMs?: number;
    }) => {
      const account = resolveWeChatAccount(
        cfg as Record<string, unknown>,
        accountId ?? undefined,
      );
      if (!account?.serverUrl) {
        return { message: "No serverUrl configured. Run: openclaw channels setup wechat" };
      }
      const client = new WeChatClient({ baseUrl: account.serverUrl });

      try {
        const result = await loginStart(client, accountId, { timeoutMs, force });
        return result;
      } catch (err) {
        return {
          message: `Login failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    loginWithQrWait: async ({ accountId, timeoutMs }: {
      cfg: any;
      accountId: string;
      timeoutMs?: number;
    }) => {
      const result = await loginWait(accountId, { timeoutMs });
      return result;
    },
  },

  // ---- Auth adapter ----
  auth: {
    login: async ({ cfg, accountId, runtime }: {
      cfg: any;
      accountId: string;
      runtime: any;
      verbose?: boolean;
    }) => {
      const account = resolveWeChatAccount(
        cfg as Record<string, unknown>,
        accountId ?? undefined,
      );
      if (!account?.serverUrl) {
        throw new Error(
          "No serverUrl configured. Run: openclaw channels setup wechat",
        );
      }

      const client = new WeChatClient({ baseUrl: account.serverUrl });

      // Check if already logged in
      try {
        const auth = await client.authStatus();
        if (auth.isLoggedIn) {
          runtime.log(
            `Already logged in${auth.loggedInUser ? ` as ${auth.loggedInUser}` : ""}`,
          );
          return;
        }
      } catch {
        // Auth check failed — proceed with login anyway
      }

      runtime.log("Starting WeChat login...\n");

      const { connected, message } = await loginTerminal(client, {
        onEvent: (event) => {
          switch (event.type) {
            case "status":
              runtime.log(`Status: ${event.message}`);
              break;
            case "qr":
              runtime.log("Scan this QR code with WeChat:\n");
              if (event.qrData) {
                // Print QR to terminal using qrcode-terminal if available,
                // otherwise show the data URL
                try {
                  const qrTerminal = require("qrcode-terminal");
                  const qrInput = event.qrBinaryData
                    ? Buffer.from(event.qrBinaryData as number[]).toString("utf-8")
                    : event.qrData;
                  qrTerminal.generate(qrInput, { small: true }, (qr: string) => {
                    runtime.log(qr);
                  });
                } catch {
                  // qrcode-terminal not available — show data URL hint
                  if (event.qrDataUrl) {
                    runtime.log("(QR data URL available — open in browser to scan)");
                  }
                }
              }
              runtime.log("\nWaiting for scan...\n");
              break;
            case "phone_confirm":
              runtime.log(
                `\n${event.message || "Please confirm login on your phone"}\n`,
              );
              break;
            case "login_success":
              runtime.log("\nLogin successful!");
              if (event.userId) {
                runtime.log(`User: ${event.userId}`);
              }
              break;
            case "login_timeout":
              runtime.log("\nLogin timed out. Please try again.");
              break;
            case "error":
              runtime.log(`\nError: ${event.message}`);
              break;
          }
        },
      });

      if (!connected) {
        throw new Error(message);
      }
    },
  },

  // ---- Status adapter ----
  status: {
    collectStatusIssues: collectWeChatStatusIssues,
  },

  // ---- Setup adapter (channels add) ----
  setup: {
    applyAccountConfig: ({ cfg, input }: { cfg: any; accountId: string; input: any }) => {
      const serverUrl = input.url || input.httpUrl || "http://localhost:6174";
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wechat: {
            ...cfg.channels?.wechat,
            enabled: true,
            serverUrl,
          },
        },
      };
    },
  },

  // ---- Onboarding adapter ----
  onboarding: wechatOnboardingAdapter,
};
