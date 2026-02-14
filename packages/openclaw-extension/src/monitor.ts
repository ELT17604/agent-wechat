import { WeChatClient } from "@thisnick/agent-wechat-shared";
import type { Chat, Message } from "@thisnick/agent-wechat-shared";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import type { ResolvedWeChatAccount } from "./types.js";
import { getWeChatRuntime } from "./runtime.js";
import { resolveWeChatAccount } from "./types.js";

// Message types that may have downloadable media
const MEDIA_TYPES = new Set([3, 34]); // image, voice

export interface WeChatMonitorOptions {
  account: ResolvedWeChatAccount;
  abortSignal: AbortSignal;
  runtime: any; // PluginRuntime
  setStatus: (next: any) => void;
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void };
  cfg: any; // OpenClawConfig
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Check whether a message is allowed through based on DM/group policies.
 */
function isMessageAllowed(
  account: ResolvedWeChatAccount,
  isGroup: boolean,
  senderId: string,
): boolean {
  if (isGroup) {
    if (account.groupPolicy === "disabled") return false;
    if (account.groupPolicy === "allowlist") {
      return account.groupAllowFrom.includes(senderId);
    }
    return true; // "open"
  }
  // Direct message
  if (account.dmPolicy === "disabled") return false;
  if (account.dmPolicy === "allowlist") {
    return account.allowFrom.includes(senderId);
  }
  return true; // "open"
}

export async function startWeChatMonitor(
  opts: WeChatMonitorOptions,
): Promise<void> {
  const { account, abortSignal, runtime, setStatus, log } = opts;
  const client = new WeChatClient({ baseUrl: account.serverUrl });

  // Track last-seen message ID per chat
  const lastSeenId = new Map<string, number>();
  let lastAuthCheck = 0;

  // Report initial status as running
  setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    linked: true,
  });

  while (!abortSignal.aborted) {
    try {
      // Reload config each iteration so hot-reloads take effect
      const cfg = getWeChatRuntime().config.loadConfig();

      // ---- Auth polling (every authPollIntervalMs) ----
      const now = Date.now();
      if (now - lastAuthCheck >= account.authPollIntervalMs) {
        lastAuthCheck = now;
        try {
          const auth = await client.authStatus();
          setStatus({
            accountId: account.accountId,
            running: true,
            connected: true,
            linked: auth.isLoggedIn,
          });
          if (!auth.isLoggedIn) {
            log?.info?.(`[wechat:${account.accountId}] Not authenticated`);
            await sleep(account.pollIntervalMs, abortSignal);
            continue;
          }
        } catch (err) {
          setStatus({
            accountId: account.accountId,
            running: true,
            connected: false,
            linked: false,
            lastError: String(err),
          });
          log?.error?.(
            `[wechat:${account.accountId}] Auth check failed: ${err}`,
          );
          await sleep(account.pollIntervalMs, abortSignal);
          continue;
        }
      }

      // ---- Message polling ----
      let chats: Chat[];
      try {
        chats = await client.listChats(50);
      } catch (err) {
        log?.error?.(
          `[wechat:${account.accountId}] Failed to list chats: ${err}`,
        );
        await sleep(account.pollIntervalMs, abortSignal);
        continue;
      }

      // Filter to chats with unreads
      const unreadChats = chats.filter((c) => c.unreadCount > 0);
      if (unreadChats.length > 0) {
        log?.info?.(
          `[wechat:${account.accountId}] ${unreadChats.length} chat(s) with unreads`,
        );
      }

      if (unreadChats.length > 0) {
        for (const chat of unreadChats) {
          if (abortSignal.aborted) break;
          await processUnreadChat(
            client,
            chat,
            lastSeenId,
            account,
            cfg,
            log,
          );
        }
      }
    } catch (err) {
      log?.error?.(
        `[wechat:${account.accountId}] Monitor error: ${err}`,
      );
    }

    await sleep(account.pollIntervalMs, abortSignal);
  }

  setStatus({
    accountId: account.accountId,
    running: false,
    connected: false,
  });
}

async function processUnreadChat(
  client: WeChatClient,
  chat: Chat,
  lastSeenId: Map<string, number>,
  account: ResolvedWeChatAccount,
  cfg: any,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<void> {
  const core = getWeChatRuntime();
  // Re-resolve account from hot-reloaded config so policy changes take effect
  const liveAccount =
    resolveWeChatAccount(cfg as Record<string, unknown>, account.accountId) ??
    account;
  const chatId = chat.username ?? chat.id;

  // Open the chat (triggers media downloads + clear unreads)
  log?.info?.(`[wechat:${liveAccount.accountId}] Opening chat ${chatId}...`);
  try {
    await client.openChat(chatId, true);
    log?.info?.(`[wechat:${liveAccount.accountId}] Opened chat ${chatId}`);
  } catch (err) {
    log?.error?.(
      `[wechat:${liveAccount.accountId}] Failed to open chat ${chatId}: ${err}`,
    );
  }

  // Give WeChat time to flush message content to DB (especially voice/media)
  await sleep(1000);

  // Determine how many messages to fetch
  const firstPoll = !lastSeenId.has(chatId);
  const prevLastSeen = lastSeenId.get(chatId) ?? 0;
  const fetchLimit = Math.max(chat.unreadCount, 20);

  let messages: Message[];
  try {
    messages = await client.listMessages(chatId, fetchLimit);
  } catch (err) {
    log?.error?.(
      `[wechat:${liveAccount.accountId}] Failed to list messages for ${chatId}: ${err}`,
    );
    return;
  }

  log?.info?.(
    `[wechat:${liveAccount.accountId}] ${chatId}: fetched ${messages.length} msgs, firstPoll=${firstPoll}, prevLastSeen=${prevLastSeen}, unreadCount=${chat.unreadCount}`,
  );

  if (messages.length === 0) return;

  // On first poll, only process the last `unreadCount` messages
  // and seed lastSeenId from the rest
  let newMessages: Message[];
  if (firstPoll) {
    messages.sort((a, b) => a.localId - b.localId);
    const unread = chat.unreadCount ?? 0;
    if (unread > 0 && unread < messages.length) {
      newMessages = messages.slice(-unread);
      const seenMax = messages[messages.length - unread - 1].localId;
      lastSeenId.set(chatId, seenMax);
    } else if (unread >= messages.length) {
      // All fetched messages are unread
      newMessages = messages;
    } else {
      // No unreads — just seed lastSeenId, don't process anything
      const maxId = messages[messages.length - 1].localId;
      lastSeenId.set(chatId, maxId);
      return;
    }
  } else {
    newMessages = messages.filter((m) => m.localId > prevLastSeen);
    if (newMessages.length === 0) {
      const maxId = Math.max(...messages.map((m) => m.localId));
      lastSeenId.set(chatId, maxId);
      return;
    }
    newMessages.sort((a, b) => a.localId - b.localId);
  }

  log?.info?.(
    `[wechat:${liveAccount.accountId}] ${chatId}: ${newMessages.length} new msg(s) to process`,
  );

  // Wait for media to settle
  await sleep(500);

  for (const msg of newMessages) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Processing msg ${msg.localId}: type=${msg.type}, sender=${msg.sender}, isSelf=${msg.isSelf}, content=${(msg.content || "").slice(0, 50)}`,
    );

    // Skip self-sent messages
    if (msg.isSelf) {
      log?.info?.(`[wechat:${liveAccount.accountId}] Skipping self-sent msg ${msg.localId}`);
      continue;
    }

    const isGroup = chatId.includes("@chatroom");
    const senderId = msg.sender ?? chatId;
    const senderName = msg.senderName ?? msg.sender ?? chat.name;

    // ---- Policy check ----
    if (!isMessageAllowed(liveAccount, isGroup, senderId)) {
      log?.info?.(`[wechat:${liveAccount.accountId}] Blocked by policy: ${isGroup ? "group" : "dm"} from ${senderId}`);
      continue;
    }

    // Attempt media download for supported types
    let mediaPath: string | undefined;
    let mediaMime: string | undefined;

    const baseType = msg.type & 0x7fffffff;
    if (MEDIA_TYPES.has(baseType)) {
      log?.info?.(`[wechat:${liveAccount.accountId}] Downloading media for msg ${msg.localId} (type ${baseType})`);
      try {
        const result = await client.getMedia(chatId, msg.localId);
        log?.info?.(`[wechat:${liveAccount.accountId}] Media result: type=${result.type}, format=${result.format}, hasData=${!!result.data}`);
        if (result.data && result.type !== "unsupported") {
          const mimeMap: Record<string, string> = {
            jpeg: "image/jpeg",
            jpg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            mp3: "audio/mpeg",
          };
          mediaMime = mimeMap[result.format] ?? `application/${result.format}`;
          // Save media to temp file via runtime
          const buf = Buffer.from(result.data, "base64");
          const saved = await core.channel.media.saveMediaBuffer(
            buf,
            mediaMime,
            "inbound",
            undefined,
            result.filename,
          );
          mediaPath = saved?.path;
          log?.info?.(`[wechat:${liveAccount.accountId}] Saved media to ${mediaPath}`);
        }
      } catch (err) {
        log?.error?.(`[wechat:${liveAccount.accountId}] Media download failed: ${err}`);
      }
    }

    const timestamp = new Date(msg.timestamp).getTime();
    // Use placeholder for media-only messages (voice, image without caption)
    // so OpenClaw's media understanding pipeline knows to process the attachment
    let rawBody = msg.content || "";
    if (!rawBody && mediaPath && mediaMime) {
      if (mediaMime.startsWith("audio/")) {
        rawBody = "<media:audio>";
      } else if (mediaMime.startsWith("image/")) {
        rawBody = "<media:image>";
      }
    }

    log?.info?.(`[wechat:${liveAccount.accountId}] Dispatching msg ${msg.localId}: body="${rawBody.slice(0, 80)}"${mediaPath ? ` media=${mediaPath}` : ""}`);

    try {
      // Resolve routing
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "wechat",
        accountId: liveAccount.accountId,
        peer: {
          kind: isGroup ? "group" : "direct",
          id: isGroup ? chatId : senderId,
        },
      });

      const fromLabel = isGroup
        ? `group:${chat.name || chatId}`
        : senderName || `user:${senderId}`;
      const storePath = core.channel.session.resolveStorePath(
        cfg.session?.store,
        { agentId: route.agentId },
      );

      // Format envelope
      const envelopeOptions =
        core.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const previousTimestamp =
        core.channel.session.readSessionUpdatedAt({
          storePath,
          sessionKey: route.sessionKey,
        });
      const body = core.channel.reply.formatAgentEnvelope({
        channel: "WeChat",
        from: fromLabel,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      });

      // Build inbound context
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: rawBody,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: isGroup ? `wechat:group:${chatId}` : `wechat:${senderId}`,
        To: `wechat:${chatId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: fromLabel,
        SenderName: senderName || undefined,
        SenderId: senderId,
        Provider: "wechat",
        Surface: "wechat",
        MessageSid: `wechat:${chatId}:${msg.localId}`,
        OriginatingChannel: "wechat",
        OriginatingTo: `wechat:${chatId}`,
        ...(mediaPath ? { MediaPath: mediaPath, MediaUrl: mediaPath, MediaType: mediaMime } : {}),
      });

      // Record session
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
          log?.error?.(
            `[wechat:${liveAccount.accountId}] Failed updating session meta: ${String(err)}`,
          );
        },
      });

      // Dispatch reply
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: route.agentId,
        channel: "wechat",
        accountId: liveAccount.accountId,
      });

      await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...prefixOptions,
          deliver: async (payload: any) => {
            const text = payload.text ?? "";
            if (text) {
              const tableMode = core.channel.text.resolveMarkdownTableMode({
                cfg,
                channel: "wechat",
                accountId: liveAccount.accountId,
              });
              const converted = core.channel.text.convertMarkdownTables(
                text,
                tableMode,
              );
              await client.sendMessage({ chatId, text: converted });
            }
          },
          onError: (err: unknown, info: any) => {
            log?.error?.(
              `[wechat:${liveAccount.accountId}] ${info.kind} reply failed: ${String(err)}`,
            );
          },
        },
        replyOptions: {
          onModelSelected,
        },
      });

      // Record activity
      core.channel.activity?.record?.({
        channel: "wechat",
        accountId: liveAccount.accountId,
        direction: "inbound",
        at: timestamp,
      });
    } catch (err) {
      log?.error?.(
        `[wechat:${liveAccount.accountId}] Failed to dispatch message ${msg.localId}: ${err}`,
      );
    }
  }

  // Update lastSeenId
  const maxId = Math.max(...newMessages.map((m) => m.localId));
  lastSeenId.set(chatId, maxId);
}
