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
  loggedInUser?: string;  // WeChat account dir (e.g. "wxid_xxx_abc123")
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
  id: string;              // WeChat username (internal ID)
  username: string;        // WeChat username (same as id, explicit)
  name: string;            // Display name (remark > nick_name > username)
  remark?: string;         // User-set contact remark
  lastMessagePreview?: string;
  lastMessageSender?: string;
  lastActivityAt?: string;
  unreadCount: number;
  isGroup: boolean;
}

export interface ListChatsParams {
  limit?: number;
}

export interface FindChatParams {
  name: string;
}

export interface GetChatParams {
  id: string;
}

export interface OpenChatParams {
  chatId: string;
}

export interface OpenChatResult {
  ok: boolean;
  username?: string;
  index?: number;
  error?: string;
}

// ============================================
// MESSAGES
// ============================================

export interface Message {
  localId: number;
  serverId: number;
  chatId: string;             // WeChat username of the chat
  sender?: string;            // Sender username (group chats)
  type: number;               // WeChat message type (1=text, 34=voice, 47=emoji, 10000=system)
  content: string;            // Message content (text or XML for media)
  timestamp: string;          // ISO 8601
}

export interface ListMessagesParams {
  chatId: string;
  limit?: number;
  offset?: number;
}

export interface SendParams {
  chatId: string;
  text?: string;
  files?: string[];
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface GetMediaParams {
  chatId: string;
  localId: number;
}

export interface MediaResult {
  type: "image" | "emoji" | "voice" | "unsupported";
  data?: string;      // base64 for image/voice
  url?: string;       // CDN URL for emoji
  format: string;
  filename: string;
}

// ============================================
// EVENTS
// ============================================

export interface LoginEvent {
  type: "login";
  state: LoginState;
}

export type ServerEvent = LoginEvent;

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
