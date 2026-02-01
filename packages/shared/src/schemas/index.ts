import { z } from "zod";

// ============================================
// SESSIONS
// ============================================

export const sessionStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "error",
]);

export const sessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  linuxUser: z.string(),
  display: z.string(),
  dbusAddress: z.string().optional(),
  vncPort: z.number().int(),
  status: sessionStatusSchema,
  loginState: z.lazy(() => loginStateSchema),
  wechatPid: z.number().int().optional(),
  xvfbPid: z.number().int().optional(),
  dbusPid: z.number().int().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createSessionParamsSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/, "Name must be alphanumeric with _ or -"),
});

export const sessionIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const sessionNameParamsSchema = z.object({
  name: z.string().min(1),
});

export const dbSessionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  linux_user: z.string(),
  display: z.string(),
  dbus_address: z.string().nullable(),
  vnc_port: z.number().int(),
  status: z.string(),
  login_state: z.string(),
  wechat_pid: z.number().int().nullable(),
  xvfb_pid: z.number().int().nullable(),
  dbus_pid: z.number().int().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// ============================================
// CONTAINER LIFECYCLE
// ============================================

export const upParamsSchema = z.object({
  image: z.string().optional(),
});

export const upResultSchema = z.object({
  url: z.string(),
});

export const statusSchema = z.object({
  container: z.enum(["running", "stopped", "unknown"]),
  loginState: z.discriminatedUnion("status", [
    z.object({ status: z.literal("logged_out") }),
    z.object({
      status: z.literal("qr_pending"),
      qrDataUrl: z.string().optional(),
    }),
    z.object({
      status: z.literal("logged_in"),
      userId: z.string().optional(),
    }),
  ]),
  version: z.string(),
});

// ============================================
// AUTHENTICATION
// ============================================

export const loginStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("logged_out") }),
  z.object({
    status: z.literal("qr_pending"),
    qrDataUrl: z.string().optional(),
  }),
  z.object({
    status: z.literal("logged_in"),
    userId: z.string().optional(),
  }),
]);

export const loginResultSchema = z.object({
  success: z.boolean(),
  state: loginStateSchema,
});

// Login subscription events (for real-time QR monitoring)
export const loginSubscriptionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), message: z.string() }),
  z.object({ type: z.literal("qr"), qrData: z.string() }),
  z.object({ type: z.literal("login_success"), userId: z.string().optional() }),
  z.object({ type: z.literal("login_timeout") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

// ============================================
// CHATS
// ============================================

export const chatSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarDescription: z.string().optional(),
  lastMessagePreview: z.string().optional(),
  lastMessageSender: z.string().optional(),
  lastActivityAt: z.string().optional(),
  unreadCount: z.number().int().nonnegative(),
  isGroup: z.boolean(),
  isPinned: z.boolean(),
  searchTerms: z.array(z.string()).optional(),
  scrollPositionHint: z.number().int().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listChatsParamsSchema = z.object({
  limit: z.number().int().positive().max(100).optional().default(50),
  unreadOnly: z.boolean().optional().default(false),
});

export const findChatParamsSchema = z.object({
  name: z.string().min(1),
});

export const getChatParamsSchema = z.object({
  id: z.string().min(1),
});

export const openChatParamsSchema = z.object({
  id: z.string().min(1),
});

// ============================================
// MESSAGES
// ============================================

export const messageContentTypeSchema = z.enum([
  "text",
  "image",
  "video",
  "file",
  "audio",
  "sticker",
  "link",
  "miniprogram",
  "location",
]);

export const messageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  contentType: messageContentTypeSchema,
  contentText: z.string().optional(),
  senderName: z.string().optional(),
  isOutgoing: z.boolean(),
  timestampDisplay: z.string().optional(),
  timestampParsed: z.string().optional(),
  adjacentTextBefore: z.string().optional(),
  adjacentTextAfter: z.string().optional(),
  isDownloaded: z.boolean(),
  downloadPath: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const sendParamsSchema = z.object({
  chatId: z.string().min(1),
  text: z.string().optional(),
  files: z.array(z.string()).optional(),
});

export const sendResultSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
});

export const getMessagesParamsSchema = z.object({
  chatId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional().default(50),
  since: z.string().optional(),
});

export const downloadAttachmentParamsSchema = z.object({
  messageId: z.string().min(1),
});

export const downloadAttachmentResultSchema = z.object({
  base64: z.string(),
  mimeType: z.string(),
  filename: z.string().optional(),
});

// ============================================
// SYNC
// ============================================

export const syncOptionsSchema = z.object({
  chatId: z.string().min(1),
  maxMessages: z.number().int().positive().max(200).optional().default(50),
});

// ============================================
// AGENT CONFIGURATION
// ============================================

export const agentConfigSchema = z.object({
  maxTurns: z.number().int().positive().default(30),
  turnTimeout: z.number().int().positive().default(60_000),
  totalTimeout: z.number().int().positive().default(600_000),
});

// ============================================
// DATABASE CLI OUTPUT SCHEMAS
// ============================================

export const dbChatRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar_description: z.string().nullable(),
  last_message_preview: z.string().nullable(),
  last_message_sender: z.string().nullable(),
  last_activity_at: z.string().nullable(),
  unread_count: z.number().int(),
  is_group: z.union([z.boolean(), z.number()]),
  is_pinned: z.union([z.boolean(), z.number()]),
  search_terms: z.string().nullable(),
  scroll_position_hint: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const dbMessageRowSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  content_type: z.string(),
  content_text: z.string().nullable(),
  sender_name: z.string().nullable(),
  is_outgoing: z.union([z.boolean(), z.number()]),
  timestamp_display: z.string().nullable(),
  timestamp_parsed: z.string().nullable(),
  adjacent_text_before: z.string().nullable(),
  adjacent_text_after: z.string().nullable(),
  is_downloaded: z.union([z.boolean(), z.number()]),
  download_path: z.string().nullable(),
  metadata: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// Type exports from schemas
export type UpParams = z.infer<typeof upParamsSchema>;
export type UpResult = z.infer<typeof upResultSchema>;
export type Status = z.infer<typeof statusSchema>;
export type LoginState = z.infer<typeof loginStateSchema>;
export type LoginResult = z.infer<typeof loginResultSchema>;
export type Chat = z.infer<typeof chatSchema>;
export type ListChatsParams = z.infer<typeof listChatsParamsSchema>;
export type FindChatParams = z.infer<typeof findChatParamsSchema>;
export type GetChatParams = z.infer<typeof getChatParamsSchema>;
export type OpenChatParams = z.infer<typeof openChatParamsSchema>;
export type MessageContentType = z.infer<typeof messageContentTypeSchema>;
export type Message = z.infer<typeof messageSchema>;
export type SendParams = z.infer<typeof sendParamsSchema>;
export type SendResult = z.infer<typeof sendResultSchema>;
export type GetMessagesParams = z.infer<typeof getMessagesParamsSchema>;
export type DownloadAttachmentParams = z.infer<typeof downloadAttachmentParamsSchema>;
export type DownloadAttachmentResult = z.infer<typeof downloadAttachmentResultSchema>;
export type SyncOptions = z.infer<typeof syncOptionsSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type DbChatRow = z.infer<typeof dbChatRowSchema>;
export type DbMessageRow = z.infer<typeof dbMessageRowSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type CreateSessionParams = z.infer<typeof createSessionParamsSchema>;
export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
export type SessionNameParams = z.infer<typeof sessionNameParamsSchema>;
export type DbSessionRow = z.infer<typeof dbSessionRowSchema>;
export type LoginSubscriptionEvent = z.infer<typeof loginSubscriptionEventSchema>;
