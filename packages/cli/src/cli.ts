#!/usr/bin/env node

import { Command, Option } from "commander";
import { createClient, createSubscriptionClient, Client, ClientOptions } from "./lib/client.js";
import { spawn, execSync } from "child_process";
import fs from "fs";
import qrTerminal from "qrcode-terminal";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const VERSION = "0.1.0";
const CONTAINER_NAME = "agent-wechat";
const DEFAULT_PORT = 6174;
const VNC_PORT = 5900;

// Get monorepo root (cli is at packages/cli)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, "../../..");

interface Config {
  serverUrl: string;
  token?: string;
}

function getConfig(): Config {
  return {
    serverUrl: process.env.AGENT_WECHAT_URL || `http://localhost:${DEFAULT_PORT}`,
    token: process.env.AGENT_WECHAT_TOKEN,
  };
}

function getImageTag(): string {
  const arch = os.arch();
  if (arch === "arm64") return "agent-wechat:arm64";
  return "agent-wechat:amd64";
}

// Create program
const program = new Command();

program
  .name("wx")
  .description("WeChat automation CLI")
  .version(VERSION)
  .option("-s, --session <name>", "Use specified session", "default");

// Helper to get client options from program
function getClientOptions(): ClientOptions {
  const config = getConfig();
  const opts = program.opts();
  return {
    url: config.serverUrl,
    token: config.token,
    sessionId: opts.session,
  };
}

// Helper to create client
function getClient(): Client {
  return createClient(getClientOptions());
}

// ============================================
// Container Commands
// ============================================

program
  .command("up")
  .description("Start the WeChat container")
  .action(cmdUp);

program
  .command("down")
  .description("Stop and remove the container")
  .action(cmdDown);

program
  .command("logs")
  .description("Show container logs")
  .action(cmdLogs);

// ============================================
// Session Commands
// ============================================

const sessionCmd = program
  .command("session")
  .description("Manage sessions");

sessionCmd
  .command("list")
  .description("List all sessions")
  .action(async () => {
    await cmdSessionList(getClient());
  });

sessionCmd
  .command("create <name>")
  .description("Create a new session")
  .action(async (name: string) => {
    await cmdSessionCreate(getClient(), name);
  });

sessionCmd
  .command("start <id>")
  .description("Start a session")
  .action(async (id: string) => {
    await cmdSessionStart(getClient(), id);
  });

sessionCmd
  .command("stop <id>")
  .description("Stop a session")
  .action(async (id: string) => {
    await cmdSessionStop(getClient(), id);
  });

sessionCmd
  .command("delete <id>")
  .description("Delete a session")
  .action(async (id: string) => {
    await cmdSessionDelete(getClient(), id);
  });

// ============================================
// API Commands
// ============================================

program
  .command("status")
  .description("Show container and login status")
  .action(async () => {
    await cmdStatus(getClient());
  });

// ============================================
// Auth Commands
// ============================================

const authCmd = program
  .command("auth")
  .description("Authentication commands");

authCmd
  .command("login")
  .description("Log in to WeChat (shows QR code)")
  .option("-t, --timeout <seconds>", "Timeout in seconds", "300")
  .option("-n, --new", "Switch to new account instead of existing")
  .action(async (opts) => {
    const timeoutMs = parseInt(opts.timeout, 10) * 1000;
    await cmdLogin(getClientOptions(), timeoutMs, opts.new ?? false);
  });

authCmd
  .command("status")
  .description("Check login status")
  .action(async () => {
    const client = getClient();
    const { isLoggedIn } = await client.status.authStatus.query();
    if (isLoggedIn) {
      console.log("Logged in");
    } else {
      console.log("Not logged in");
    }
  });

// ============================================
// Chats Commands
// ============================================

const chatsCmd = program
  .command("chats")
  .description("Chat management commands");

chatsCmd
  .command("list")
  .description("List chats from WeChat database")
  .option("-l, --limit <number>", "Maximum number of chats", "50")
  .option("-o, --offset <number>", "Skip first N chats", "0")
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    await cmdChats(getClient(), parseInt(opts.limit, 10), parseInt(opts.offset, 10), opts.json ?? false);
  });

chatsCmd
  .command("get <chatId>")
  .description("Get details for a specific chat")
  .option("-j, --json", "Output as JSON")
  .action(async (chatId: string, opts) => {
    await cmdChatGet(getClient(), chatId, opts.json ?? false);
  });

chatsCmd
  .command("find <name>")
  .description("Find chat by name")
  .action(async (name: string) => {
    await cmdFind(getClient(), name);
  });

chatsCmd
  .command("open <chatId>")
  .description("Open a chat in WeChat UI (triggers media downloads + clears unread)")
  .action(async (chatId: string) => {
    await cmdChatOpen(getClient(), chatId);
  });

// ============================================
// Messages Commands
// ============================================

const messagesCmd = program
  .command("messages")
  .description("Message commands");

messagesCmd
  .command("list <chatId>")
  .description("List messages for a chat")
  .option("-l, --limit <number>", "Maximum number of messages", "50")
  .option("-o, --offset <number>", "Skip first N messages", "0")
  .option("-j, --json", "Output as JSON")
  .action(async (chatId: string, opts) => {
    await cmdMessages(getClient(), chatId, parseInt(opts.limit, 10), parseInt(opts.offset, 10), opts.json ?? false);
  });

messagesCmd
  .command("media <chatId> <localId>")
  .description("Save media attachment (image thumbnail, emoji, or voice)")
  .option("-o, --output <path>", "Output file path")
  .action(async (chatId: string, localIdStr: string, opts) => {
    await cmdMedia(getClient(), chatId, parseInt(localIdStr, 10), opts.output);
  });

messagesCmd
  .command("send <chatId>")
  .description("Send a message to a chat")
  .option("--text <text>", "Text message to send")
  .option("--image <path>", "Image file to send")
  .action(async (chatId: string, opts: { text?: string; image?: string }) => {
    if (!opts.text && !opts.image) {
      console.error("Must provide --text or --image");
      process.exit(1);
    }

    let image: { data: string; mimeType: string } | undefined;
    if (opts.image) {
      if (!fs.existsSync(opts.image)) {
        console.error(`File not found: ${opts.image}`);
        process.exit(1);
      }
      const data = fs.readFileSync(opts.image);
      const ext = path.extname(opts.image).toLowerCase();
      const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
                       ext === ".gif" ? "image/gif" : "image/png";
      image = { data: data.toString("base64"), mimeType };
    }

    await cmdSend(getClient(), chatId, opts.text, image);
  });

// ============================================
// Debug Commands
// ============================================

program
  .command("screenshot")
  .description("Save screenshot to file")
  .argument("[file]", "Output file path", "screenshot.png")
  .action(async (file: string) => {
    await cmdScreenshot(getClient(), file);
  });

program
  .command("a11y")
  .description("Dump accessibility tree")
  .addOption(
    new Option("-f, --format <format>", "Output format")
      .choices(["json", "aria"])
      .default("json")
  )
  .action(async (options: { format: "json" | "aria" }) => {
    await cmdA11y(getClient(), options.format);
  });

// ============================================
// Command Implementations
// ============================================

async function cmdStatus(client: Client) {
  const status = await client.status.get.query();
  console.log("Container:", status.container);
  console.log("Version:", status.version);
  console.log("Login State:", JSON.stringify(status.loginState, null, 2));
}

async function cmdLogin(options: ClientOptions, timeoutMs: number = 300_000, newAccount: boolean = false) {
  console.log(newAccount ? "Initiating login with new account...\n" : "Initiating login...\n");

  const { client, close } = createSubscriptionClient(options);
  let subscription: { unsubscribe: () => void } | null = null;

  // Handle Ctrl+C to abort subscription
  const abortHandler = () => {
    console.log("\n\nLogin cancelled.");
    if (subscription) {
      subscription.unsubscribe();
    }
    close();
    process.exit(0);
  };
  process.on("SIGINT", abortHandler);

  try {
    await new Promise<void>((resolve, reject) => {
      subscription = client.status.loginSubscription.subscribe(
        { timeoutMs, newAccount },
        {
          onData: (event) => {
            switch (event.type) {
              case "status":
                console.log(`Status: ${event.message}`);
                break;
              case "qr":
                console.log("Scan this QR code with WeChat:\n");
                // Use binaryData if available (preserves exact bytes), fallback to string
                const qrInput = event.qrBinaryData
                  ? Buffer.from(event.qrBinaryData as number[]).toString("utf-8")
                  : event.qrData;
                qrTerminal.generate(qrInput as string, { small: true });
                console.log("\nWaiting for scan... (Ctrl+C to cancel)\n");
                break;
              case "phone_confirm":
                console.log(`\n📱 ${event.message || "Please confirm login on your phone"}\n`);
                break;
              case "login_success":
                console.log("\n\nLogin successful!");
                if (event.userId) {
                  console.log(`User ID: ${event.userId}`);
                }
                resolve();
                break;
              case "login_timeout":
                console.log("\n\nLogin timed out. Please try again.");
                resolve();
                break;
              case "error":
                console.error(`\nError: ${event.message}`);
                reject(new Error(event.message));
                break;
            }
          },
          onError: (err) => {
            console.error("\nConnection error:", err.message);
            reject(err);
          },
          onComplete: () => {
            // Subscription completed normally
          },
        }
      );
    });
  } finally {
    process.removeListener("SIGINT", abortHandler);
    close();
  }
}

async function cmdChats(client: Client, limit: number = 50, offset: number = 0, json: boolean = false) {
  const chats = await client.chats.list.query({ limit, offset });

  if (json) {
    console.log(JSON.stringify(chats, null, 2));
    return;
  }

  if (chats.length === 0) {
    console.log("No chats found. Make sure you're logged in.");
    return;
  }

  console.log(`Found ${chats.length} chat(s):\n`);

  // Chat ID column width based on actual data
  const maxIdLen = Math.max(10, ...chats.map(c => c.username?.length ?? c.id.length));
  const idHeader = "Chat ID".padEnd(maxIdLen);
  console.log(`${idHeader}  Unread  Group  Name`);
  console.log("-".repeat(maxIdLen + 30));
  for (const chat of chats) {
    const id = (chat.username ?? chat.id).padEnd(maxIdLen);
    const unread = chat.unreadCount > 0 ? String(chat.unreadCount).padStart(2) : "  ";
    const group = chat.isGroup ? "  Y  " : "     ";
    console.log(`${id}  ${unread}    ${group}  ${chat.name}`);
  }
}

async function cmdChatGet(client: Client, chatId: string, json: boolean = false) {
  const chat = await client.chats.get.query({ id: chatId });

  if (!chat) {
    console.error(`Chat not found: ${chatId}`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(chat, null, 2));
    return;
  }

  console.log(`Chat ID:        ${chat.username ?? chat.id}`);
  console.log(`Name:           ${chat.name}`);
  if (chat.remark) console.log(`Remark:         ${chat.remark}`);
  console.log(`Group:          ${chat.isGroup ? "Yes" : "No"}`);
  console.log(`Unread:         ${chat.unreadCount}`);
  if (chat.lastMessagePreview) {
    const sender = chat.lastMessageSender ? `${chat.lastMessageSender}: ` : "";
    console.log(`Last message:   ${sender}${chat.lastMessagePreview}`);
  }
  if (chat.lastActivityAt) console.log(`Last activity:  ${chat.lastActivityAt}`);
}

/** WeChat base message types */
const MSG_BASE_TYPES: Record<number, string> = {
  1: "text",
  3: "image",
  34: "voice",
  43: "video",
  47: "emoji",
  49: "appmsg",
  10000: "system",
  10002: "revoke",
};

/** Appmsg (type 49) subtypes */
const APPMSG_SUB_TYPES: Record<number, string> = {
  1: "text-link",
  3: "music",
  4: "video",
  5: "link",
  6: "file",
  8: "sticker",
  19: "location",
  33: "mini-program",
  36: "mini-program",
  57: "reply",
  63: "livestream",
};

function getMsgTypeLabel(rawType: number): string {
  const base = rawType & 0xFFFFFFFF;
  const sub = Math.floor(rawType / 0x100000000);

  const baseLabel = MSG_BASE_TYPES[base];
  if (!baseLabel) return `type:${rawType}`;

  if (base === 49 && sub > 0) {
    return APPMSG_SUB_TYPES[sub] ?? `appmsg:${sub}`;
  }
  return baseLabel;
}

async function cmdMessages(client: Client, chatId: string, limit: number = 50, offset: number = 0, json: boolean = false) {
  const messages = await client.messages.list.query({ chatId, limit, offset });

  if (json) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }

  if (messages.length === 0) {
    console.log("No messages found.");
    return;
  }

  // Display messages oldest-first for natural reading order
  const sorted = [...messages].reverse();

  // Compute column widths
  const maxIdLen = Math.max(2, ...sorted.map(m => String(m.localId).length));
  const maxTypeLen = Math.max(4, ...sorted.map(m => getMsgTypeLabel(m.type).length));

  // Header
  console.log(`${"ID".padEnd(maxIdLen)}  ${"Time".padEnd(22)}  ${"Type".padEnd(maxTypeLen)}  Message`);
  console.log("-".repeat(maxIdLen + maxTypeLen + 32));

  for (const msg of sorted) {
    const time = new Date(msg.timestamp).toLocaleString();
    const typeLabel = getMsgTypeLabel(msg.type);
    const id = String(msg.localId).padEnd(maxIdLen);
    const sender = msg.sender ? `${msg.sender}: ` : "";
    const preview = msg.content.length > 120 ? msg.content.slice(0, 120) + "..." : msg.content;

    console.log(`${id}  ${time.padEnd(22)}  ${typeLabel.padEnd(maxTypeLen)}  ${sender}${preview}`);
  }

  console.log(`\n${messages.length} message(s) shown.`);
}

async function cmdMedia(client: Client, chatId: string, localId: number, outputPath?: string) {
  const result = await client.messages.media.query({ chatId, localId });

  if (result.type === "unsupported") {
    console.error("No media found for this message (unsupported type or not found).");
    process.exit(1);
  }

  const outFile = outputPath ?? result.filename;

  if (result.type === "emoji" && result.url) {
    // Download from CDN URL
    console.log(`Downloading emoji from CDN...`);
    const response = await fetch(result.url);
    if (!response.ok) {
      console.error(`Failed to download emoji: HTTP ${response.status}`);
      process.exit(1);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outFile, buffer);
    console.log(`Saved ${result.type} to ${outFile} (${buffer.length} bytes)`);
  } else if (result.data) {
    // Decode base64
    const buffer = Buffer.from(result.data, "base64");
    fs.writeFileSync(outFile, buffer);
    console.log(`Saved ${result.type} to ${outFile} (${buffer.length} bytes)`);
  } else if (result.type === "image") {
    console.error("Image thumbnail not yet cached by WeChat. Try opening the chat in the app first.");
    process.exit(1);
  } else if (result.type === "emoji") {
    console.log(`Emoji found (md5 in filename: ${result.filename}) but no CDN URL available.`);
    process.exit(1);
  }
}

async function cmdFind(client: Client, name: string) {
  const chats = await client.chats.find.query({ name });
  if (chats.length === 0) {
    console.log(`No chats found matching "${name}"`);
    return;
  }

  console.log(`Found ${chats.length} matching chats:\n`);
  for (const chat of chats) {
    console.log(`  ${chat.id}: ${chat.name}`);
  }
}

async function cmdChatOpen(client: Client, chatId: string) {
  console.log(`Opening chat ${chatId}...`);
  const result = await client.chats.open.mutate({ chatId });

  if (result.ok) {
    console.log(`Chat opened: ${result.username} (index ${result.index})`);
  } else {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
}

async function cmdSend(client: Client, chatId: string, text?: string, image?: { data: string; mimeType: string }) {
  console.log(`Sending ${image ? "image" : "message"} to ${chatId}...`);
  const result = await client.messages.send.mutate({
    chatId,
    ...(text ? { text } : {}),
    ...(image ? { image } : {}),
  });

  if (result.success) {
    console.log("Message sent successfully!");
    if (result.messageId) {
      console.log(`Message ID: ${result.messageId}`);
    }
  } else {
    console.error(`Failed to send message: ${result.error || "Unknown error"}`);
    process.exit(1);
  }
}

async function cmdScreenshot(client: Client, outputPath: string) {
  console.log(`Capturing screenshot...`);
  const result = await client.debug.screenshot.query();
  const buffer = Buffer.from(result.base64, "base64");
  fs.writeFileSync(outputPath, buffer);
  console.log(`Screenshot saved to ${outputPath}`);
}

async function cmdA11y(client: Client, format: "json" | "aria") {
  const result = await client.debug.a11y.query({ format });
  if (result.error) {
    console.error(`Error: ${result.error}`);
    return;
  }
  if (format === "aria" && result.aria) {
    console.log(result.aria);
  } else if (result.tree) {
    console.log(JSON.stringify(result.tree, null, 2));
  }
}

// ============================================
// Session Commands Implementation
// ============================================

async function cmdSessionList(client: Client) {
  const sessions = await client.sessions.list.query();
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log(`Found ${sessions.length} session(s):\n`);
  for (const session of sessions) {
    const status = session.status === "running" ? "✓ running" : session.status;
    const login = session.loginState.status === "logged_in" ? "logged in" : session.loginState.status;
    console.log(`  ${session.id}: ${session.name}`);
    console.log(`    Status: ${status}, Login: ${login}`);
    console.log(`    Display: ${session.display}, VNC: ${session.vncPort}`);
    console.log(`    User: ${session.linuxUser}`);
    if (session.errorMessage) {
      console.log(`    Error: ${session.errorMessage}`);
    }
    console.log();
  }
}

async function cmdSessionCreate(client: Client, name: string) {
  console.log(`Creating session "${name}"...`);
  const session = await client.sessions.create.mutate({ name });
  console.log(`Session created!`);
  console.log(`  ID: ${session.id}`);
  console.log(`  Name: ${session.name}`);
  console.log(`  User: ${session.linuxUser}`);
  console.log(`  Display: ${session.display}`);
  console.log(`  VNC Port: ${session.vncPort}`);
  console.log(`\nStart the session with: pnpm cli session start ${session.name}`);
}

async function cmdSessionStart(client: Client, idOrName: string) {
  console.log(`Starting session "${idOrName}"...`);
  const session = await client.sessions.start.mutate({ id: idOrName });
  console.log(`Session started!`);
  console.log(`  Status: ${session.status}`);
  console.log(`  Display: ${session.display}`);
  console.log(`  VNC Port: ${session.vncPort}`);
  if (session.dbusAddress) {
    console.log(`  D-Bus: ${session.dbusAddress}`);
  }
  console.log(`\nLogin with: pnpm cli --session ${session.name} login`);
}

async function cmdSessionStop(client: Client, idOrName: string) {
  console.log(`Stopping session "${idOrName}"...`);
  const session = await client.sessions.stop.mutate({ id: idOrName });
  console.log(`Session stopped.`);
  console.log(`  Status: ${session.status}`);
}

async function cmdSessionDelete(client: Client, idOrName: string) {
  console.log(`Deleting session "${idOrName}"...`);
  const result = await client.sessions.delete.mutate({ id: idOrName });
  if (result.success) {
    console.log(`Session deleted.`);
  } else {
    console.error(`Failed to delete session.`);
    process.exit(1);
  }
}

// ============================================
// Container Commands Implementation
// ============================================

async function cmdUp() {
  const image = getImageTag();

  // Check if container already exists
  try {
    const existingId = execSync(`docker ps -aq -f "name=^${CONTAINER_NAME}$"`, { encoding: "utf-8" }).trim();
    if (existingId) {
      const running = execSync(`docker ps -q -f "name=^${CONTAINER_NAME}$"`, { encoding: "utf-8" }).trim();
      if (running) {
        console.log(`Container ${CONTAINER_NAME} is already running.`);
        console.log(`API: http://localhost:${DEFAULT_PORT}`);
        console.log(`VNC: localhost:${VNC_PORT}`);
        return;
      }
      console.log(`Starting existing container ${CONTAINER_NAME}...`);
      execSync(`docker start ${CONTAINER_NAME}`, { stdio: "inherit" });
      console.log(`API: http://localhost:${DEFAULT_PORT}`);
      console.log(`VNC: localhost:${VNC_PORT}`);
      return;
    }
  } catch {
    // No container found, continue to create
  }

  // Check if image exists
  try {
    execSync(`docker image inspect ${image}`, { stdio: "ignore" });
  } catch {
    console.error(`Image ${image} not found.`);
    console.error(`Run 'pnpm build:image:local' first to build the image.`);
    process.exit(1);
  }

  console.log(`Starting container ${CONTAINER_NAME} from ${image}...`);

  const dockerArgs = [
    "run", "-d",
    "--name", CONTAINER_NAME,
    "--security-opt", "seccomp=unconfined",
    "--cap-add=SYS_PTRACE",
    "-p", `${DEFAULT_PORT}:${DEFAULT_PORT}`,
    "-p", `${VNC_PORT}:${VNC_PORT}`,
    "-v", `${CONTAINER_NAME}-data:/data`,
    "-v", `${CONTAINER_NAME}-wechat-home:/home/wechat`,
    image,
  ];

  try {
    execSync(`docker ${dockerArgs.join(" ")}`, { stdio: "inherit" });
    console.log(`\nContainer started successfully!`);
    console.log(`API: http://localhost:${DEFAULT_PORT}`);
    console.log(`VNC: localhost:${VNC_PORT}`);
    console.log(`\nWaiting for server to be ready...`);

    for (let i = 0; i < 30; i++) {
      try {
        const response = await fetch(`http://localhost:${DEFAULT_PORT}/health`);
        if (response.ok) {
          console.log("Server is ready!");
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, 1000));
      process.stdout.write(".");
    }
    console.log("\nServer did not become ready in time. Check logs with: pnpm cli logs");
  } catch (error) {
    console.error("Failed to start container:", error);
    process.exit(1);
  }
}

async function cmdDown() {
  console.log(`Stopping container ${CONTAINER_NAME}...`);
  try {
    execSync(`docker stop ${CONTAINER_NAME}`, { stdio: "inherit" });
    execSync(`docker rm ${CONTAINER_NAME}`, { stdio: "inherit" });
    console.log("Container stopped and removed.");
  } catch {
    console.log("Container not found or already stopped.");
  }
}

async function cmdLogs() {
  try {
    const logs = spawn("docker", ["logs", "-f", CONTAINER_NAME], {
      stdio: "inherit",
    });
    logs.on("error", () => {
      console.error(`Container ${CONTAINER_NAME} not found.`);
      process.exit(1);
    });
  } catch {
    console.error(`Container ${CONTAINER_NAME} not found.`);
    process.exit(1);
  }
}

// Parse and run
program.parseAsync(process.argv).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
