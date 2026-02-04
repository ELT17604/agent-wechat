import { createTRPCClient, httpBatchLink, splitLink, createWSClient, wsLink } from "@trpc/client";
import superjson from "superjson";
import WebSocket from "ws";
import type {
  Chat,
  Message,
  LoginState,
  LoginResult,
  SendResult,
  Status,
  Session,
  DownloadAttachmentResult,
  LoginSubscriptionEvent,
  SyncSubscriptionEvent,
} from "@thisnick/agent-wechat-shared";

export interface ClientOptions {
  url: string;
  token?: string;
  sessionId?: string;
}

// Client interface that matches the server's router structure
// This provides type safety without needing to import from server
export interface Client {
  status: {
    get: { query: () => Promise<Status> };
    loginState: { query: () => Promise<LoginState> };
    authStatus: { query: () => Promise<{ isLoggedIn: boolean }> };
    login: { mutate: () => Promise<LoginResult> };
  };
  chats: {
    list: { query: (input: { limit?: number; unreadOnly?: boolean }) => Promise<Chat[]> };
    get: { query: (input: { id: string }) => Promise<Chat | null> };
    find: { query: (input: { name: string }) => Promise<Chat[]> };
    open: { mutate: (input: { id: string }) => Promise<void> };
  };
  messages: {
    get: { query: (input: { chatId: string; limit?: number; since?: string }) => Promise<Message[]> };
    send: { mutate: (input: { chatId: string; text: string; files?: string[] }) => Promise<SendResult> };
    sync: { mutate: (input: { chatId: string; maxMessages?: number }) => Promise<{ count: number }> };
    download: { query: (input: { messageId: string }) => Promise<DownloadAttachmentResult> };
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

export function createClient(options: ClientOptions): Client {
  const baseUrl = options.url.startsWith("http")
    ? options.url
    : `http://${options.url}`;

  // Build headers
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.sessionId) {
    headers["X-Session-Id"] = options.sessionId;
  }

  // Create tRPC client with superjson transformer
  // Cast to our Client interface for type safety
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createTRPCClient<any>({
    links: [
      httpBatchLink({
        url: baseUrl,
        transformer: superjson,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      }),
    ],
  }) as unknown as Client;

  return client;
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
  chats: {
    syncSubscription: {
      subscribe: (
        input: { maxChats?: number; timeoutMs?: number },
        callbacks: {
          onData: (event: SyncSubscriptionEvent) => void;
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
  const baseUrl = options.url.startsWith("http")
    ? options.url
    : `http://${options.url}`;

  // Convert http(s):// to ws(s)://
  const wsUrl = baseUrl.replace(/^http/, "ws");

  // Create WebSocket client with ws polyfill for Node.js
  const wsClient = createWSClient({
    url: wsUrl,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  });

  // Build headers
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.sessionId) {
    headers["X-Session-Id"] = options.sessionId;
  }

  // Create tRPC client with split link (ws for subscriptions, http for queries/mutations)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createTRPCClient<any>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: wsLink({
          client: wsClient,
          transformer: superjson,
        }),
        false: httpBatchLink({
          url: baseUrl,
          transformer: superjson,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        }),
      }),
    ],
  }) as unknown as SubscriptionClient;

  return {
    client,
    close: () => wsClient.close(),
  };
}
