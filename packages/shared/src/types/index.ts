// ============================================
// SESSIONS
// ============================================

export type SessionStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface Session {
  id: string;
  name: string;
  linuxUser: string;
  display: string;
  dbusAddress?: string;
  vncPort: number;
  status: SessionStatus;
  loginState: LoginState;
  wechatPid?: number;
  xvfbPid?: number;
  dbusPid?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionParams {
  name: string;
}

export interface SessionIdParams {
  id: string;
}

export interface SessionNameParams {
  name: string;
}

// ============================================
// CONTAINER LIFECYCLE
// ============================================

export interface UpParams {
  image?: string;
}

export interface UpResult {
  url: string;
}

export interface Status {
  container: "running" | "stopped" | "unknown";
  loginState: LoginState;
  version: string;
}

// ============================================
// AUTHENTICATION
// ============================================

export type LoginState =
  | { status: "logged_out" }
  | { status: "qr_pending"; qrDataUrl?: string }
  | { status: "logged_in"; userId?: string };

export interface LoginResult {
  success: boolean;
  state: LoginState;
}

// Login subscription events (for real-time QR monitoring)
export type LoginSubscriptionEvent =
  | { type: "status"; message: string }           // Status update
  | { type: "qr"; qrData: string; qrBinaryData?: number[]; qrDataUrl?: string }  // QR code
  | { type: "phone_confirm"; message?: string }   // User needs to confirm on phone
  | { type: "login_success"; userId?: string }    // Login confirmed
  | { type: "login_timeout" }                     // QR expired
  | { type: "error"; message: string };           // No QR found, etc.

// ============================================
// CHATS
// ============================================

export interface Chat {
  id: string;
  name: string;
  avatarDescription?: string;
  lastMessagePreview?: string;
  lastMessageSender?: string;
  lastActivityAt?: string;
  unreadCount: number;
  isGroup: boolean;
  isPinned: boolean;
  searchTerms?: string[];
  scrollPositionHint?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListChatsParams {
  limit?: number;
  unreadOnly?: boolean;
}

export interface FindChatParams {
  name: string;
}

export interface GetChatParams {
  id: string;
}

export interface OpenChatParams {
  id: string;
}

// ============================================
// MESSAGES
// ============================================

export type MessageContentType =
  | "text"
  | "image"
  | "video"
  | "file"
  | "audio"
  | "sticker"
  | "link"
  | "miniprogram"
  | "location";

export interface Message {
  id: string;
  chatId: string;
  contentType: MessageContentType;
  contentText?: string;
  senderName?: string;
  isOutgoing: boolean;
  timestampDisplay?: string;
  timestampParsed?: string;
  adjacentTextBefore?: string;
  adjacentTextAfter?: string;
  isDownloaded: boolean;
  downloadPath?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SendParams {
  chatId: string;
  text?: string;
  files?: string[]; // base64 encoded files
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface GetMessagesParams {
  chatId: string;
  limit?: number;
  since?: string;
}

export interface DownloadAttachmentParams {
  messageId: string;
}

export interface DownloadAttachmentResult {
  base64: string;
  mimeType: string;
  filename?: string;
}

// ============================================
// EVENTS
// ============================================

export interface MessageEvent {
  type: "message";
  message: Message;
}

export interface LoginEvent {
  type: "login";
  state: LoginState;
}

export interface QrEvent {
  type: "qr";
  dataUrl: string;
}

export type ServerEvent = MessageEvent | LoginEvent | QrEvent;

// ============================================
// AGENT CONFIGURATION
// ============================================

export interface AgentConfig {
  maxTurns: number;
  turnTimeout: number;
  totalTimeout: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxTurns: 30,
  turnTimeout: 60_000,
  totalTimeout: 600_000,
};

// ============================================
// STREAMING (stubbed for future)
// ============================================

export interface ScreenFrame {
  frame: string; // base64 JPEG
  timestamp: number;
  width: number;
  height: number;
}

export interface RTCSignal {
  type: "offer" | "answer" | "ice";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface StreamConfig {
  screen?: {
    enabled: boolean;
    fps: number;
    quality: number;
    region?: { x: number; y: number; w: number; h: number };
  };
  audio?: {
    enabled: boolean;
    codec: "opus";
    sampleRate: 48000;
    channels: 1 | 2;
    echoCancellation: boolean;
    noiseSuppression: boolean;
  };
}
