import WebSocket from "ws";
import type {
  Chat,
  Message,
  MediaResult,
  LoginResult,
  SendResult,
  Session,
  LoginSubscriptionEvent,
  OpenChatResult,
} from "@thisnick/agent-wechat-shared";

export interface ClientOptions {
  url: string;
  token?: string;
  sessionId?: string;
}

// Status types (not in shared package — server returns dynamic JSON)
export type LoginState = { status: string };
export type Status = { container: string; loginState: LoginState; version: string };

// Client interface that matches the server's router structure
export interface Client {
  status: {
    get: { query: () => Promise<Status> };
    loginState: { query: () => Promise<LoginState> };
    authStatus: { query: () => Promise<{ isLoggedIn: boolean; loggedInUser?: string }> };
    login: { mutate: () => Promise<LoginResult> };
  };
  chats: {
    list: { query: (input: { limit?: number; offset?: number }) => Promise<Chat[]> };
    get: { query: (input: { id: string }) => Promise<Chat | null> };
    find: { query: (input: { name: string }) => Promise<Chat[]> };
    open: { mutate: (input: { chatId: string }) => Promise<OpenChatResult> };
  };
  messages: {
    list: { query: (input: { chatId: string; limit?: number; offset?: number }) => Promise<Message[]> };
    media: { query: (input: { chatId: string; localId: number }) => Promise<MediaResult> };
    send: { mutate: (input: { chatId: string; text?: string; image?: { data: string; mimeType: string }; file?: { data: string; filename: string } }) => Promise<SendResult> };
  };
  debug: {
    screenshot: { query: () => Promise<{ base64: string }> };
    a11y: { query: (input: { format: "json" | "aria" }) => Promise<{ tree: unknown; aria: string | null; error?: string }> };
  };
  sessions: {
    create: { mutate: (input: { name: string }) => Promise<Session> };
    list: { query: () => Promise<Session[]> };
    get: { query: (input: { id: string }) => Promise<Session | null> };
    start: { mutate: (input: { id: string }) => Promise<Session> };
    stop: { mutate: (input: { id: string }) => Promise<Session> };
    delete: { mutate: (input: { id: string }) => Promise<{ success: boolean }> };
  };
}

function buildHeaders(options: ClientOptions): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.sessionId) headers["X-Session-Id"] = options.sessionId;
  return headers;
}

function apiUrl(base: string): string {
  const url = base.startsWith("http") ? base : `http://${base}`;
  return url.replace(/\/$/, "");
}

async function get<T>(base: string, path: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function post<T>(base: string, path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function del<T>(base: string, path: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function qs(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

export function createClient(options: ClientOptions): Client {
  const base = apiUrl(options.url);
  const headers = buildHeaders(options);

  return {
    status: {
      get: { query: () => get(base, "/api/status", headers) },
      loginState: { query: () => get<Status>(base, "/api/status", headers).then(s => s.loginState) },
      authStatus: { query: () => get(base, "/api/status/auth", headers) },
      login: { mutate: () => post(base, "/api/status/login", null, headers) },
    },
    chats: {
      list: { query: (input) => get(base, `/api/chats${qs({ limit: input.limit, offset: input.offset })}`, headers) },
      get: { query: (input) => get(base, `/api/chats/${encodeURIComponent(input.id)}`, headers) },
      find: { query: (input) => get(base, `/api/chats/find${qs({ name: input.name })}`, headers) },
      open: { mutate: (input) => post(base, `/api/chats/${encodeURIComponent(input.chatId)}/open`, null, headers) },
    },
    messages: {
      list: { query: (input) => get(base, `/api/messages/${encodeURIComponent(input.chatId)}${qs({ limit: input.limit, offset: input.offset })}`, headers) },
      media: { query: (input) => get(base, `/api/messages/${encodeURIComponent(input.chatId)}/media/${input.localId}`, headers) },
      send: { mutate: (input) => post(base, "/api/messages/send", input, headers) },
    },
    debug: {
      screenshot: { query: () => get(base, "/api/debug/screenshot", headers) },
      a11y: { query: (input) => get(base, `/api/debug/a11y${qs({ format: input.format })}`, headers) },
    },
    sessions: {
      create: { mutate: (input) => post(base, "/api/sessions", input, headers) },
      list: { query: () => get(base, "/api/sessions", headers) },
      get: { query: (input) => get(base, `/api/sessions/${encodeURIComponent(input.id)}`, headers) },
      start: { mutate: (input) => post(base, `/api/sessions/${encodeURIComponent(input.id)}/start`, null, headers) },
      stop: { mutate: (input) => post(base, `/api/sessions/${encodeURIComponent(input.id)}/stop`, null, headers) },
      delete: { mutate: (input) => del(base, `/api/sessions/${encodeURIComponent(input.id)}`, headers) },
    },
  };
}

// Subscription client interface for WebSocket-based subscriptions
export interface SubscriptionClient {
  status: {
    loginSubscription: {
      subscribe: (
        input: { timeoutMs?: number; newAccount?: boolean },
        callbacks: {
          onData: (event: LoginSubscriptionEvent) => void;
          onError?: (err: Error) => void;
          onComplete?: () => void;
        }
      ) => { unsubscribe: () => void };
    };
  };
}

export interface SubscriptionClientResult {
  client: SubscriptionClient;
  close: () => void;
}

/**
 * Create a WebSocket-capable client for subscriptions
 */
export function createSubscriptionClient(options: ClientOptions): SubscriptionClientResult {
  const base = apiUrl(options.url);
  const wsUrl = base.replace(/^http/, "ws");

  let activeWs: WebSocket | null = null;

  const client: SubscriptionClient = {
    status: {
      loginSubscription: {
        subscribe: (input, callbacks) => {
          const params = qs({ timeoutMs: input.timeoutMs, newAccount: input.newAccount });
          const ws = new WebSocket(`${wsUrl}/api/ws/login${params}`);
          activeWs = ws;

          ws.on("message", (data: Buffer) => {
            try {
              const event = JSON.parse(data.toString()) as LoginSubscriptionEvent;
              callbacks.onData(event);
            } catch (e) {
              callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
            }
          });

          ws.on("error", (err: Error) => {
            callbacks.onError?.(err);
          });

          ws.on("close", () => {
            callbacks.onComplete?.();
          });

          return {
            unsubscribe: () => {
              ws.close();
              activeWs = null;
            },
          };
        },
      },
    },
  };

  return {
    client,
    close: () => {
      activeWs?.close();
      activeWs = null;
    },
  };
}
