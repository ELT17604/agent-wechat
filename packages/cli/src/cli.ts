#!/usr/bin/env node

import { Command } from "commander";
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
const DEBUG_PORT = 9229;

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
  .description("Start the WeChat container (production mode)")
  .action(cmdUp);

program
  .command("dev")
  .description("Start in dev mode (hot reload + debugging)")
  .action(cmdDev);

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

program
  .command("login")
  .description("Log in to WeChat (shows QR code)")
  .option("-t, --timeout <seconds>", "Timeout in seconds", "300")
  .option("-n, --new", "Switch to new account instead of existing")
  .action(async (opts) => {
    const timeoutMs = parseInt(opts.timeout, 10) * 1000;
    await cmdLogin(getClientOptions(), timeoutMs, opts.new ?? false);
  });

program
  .command("chats")
  .description("List chats")
  .argument("[limit]", "Maximum number of chats to show")
  .action(async (limit?: string) => {
    await cmdChats(getClient(), limit ? parseInt(limit, 10) : undefined);
  });

program
  .command("find <name>")
  .description("Find chat by name")
  .action(async (name: string) => {
    await cmdFind(getClient(), name);
  });

program
  .command("messages <chatId>")
  .description("Get messages from a chat")
  .argument("[limit]", "Maximum number of messages")
  .action(async (chatId: string, limit?: string) => {
    await cmdMessages(getClient(), chatId, limit ? parseInt(limit, 10) : undefined);
  });

program
  .command("send <chatId> <message...>")
  .description("Send a message to a chat")
  .action(async (chatId: string, messageParts: string[]) => {
    await cmdSend(getClient(), chatId, messageParts.join(" "));
  });

program
  .command("sync <chatId>")
  .description("Sync messages from WeChat UI")
  .argument("[maxMessages]", "Maximum messages to sync")
  .action(async (chatId: string, maxMessages?: string) => {
    await cmdSync(getClient(), chatId, maxMessages ? parseInt(maxMessages, 10) : undefined);
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
  .argument("[scope]", "Scope: chats|messages|buttons|full|desktop", "full")
  .action(async (scope: string) => {
    await cmdA11y(getClient(), scope as "chats" | "messages" | "buttons" | "full");
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

async function cmdChats(client: Client, limit?: number) {
  const chats = await client.chats.list.query({ limit });
  if (chats.length === 0) {
    console.log("No chats found. Try syncing first.");
    return;
  }

  console.log(`Found ${chats.length} chats:\n`);
  for (const chat of chats) {
    const unread = chat.unreadCount > 0 ? ` [${chat.unreadCount} unread]` : "";
    const preview = chat.lastMessagePreview ? ` - ${chat.lastMessagePreview.slice(0, 30)}...` : "";
    console.log(`  ${chat.id}: ${chat.name}${unread}${preview}`);
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

async function cmdMessages(client: Client, chatId: string, limit?: number) {
  const messages = await client.messages.get.query({ chatId, limit });
  if (messages.length === 0) {
    console.log("No messages found. Try syncing first.");
    return;
  }

  console.log(`Found ${messages.length} messages:\n`);
  for (const msg of messages) {
    const sender = msg.isOutgoing ? "You" : (msg.senderName || "Unknown");
    const time = msg.timestampDisplay || msg.timestampParsed || "";
    const content = msg.contentText || `[${msg.contentType}]`;
    console.log(`  [${time}] ${sender}: ${content}`);
  }
}

async function cmdSend(client: Client, chatId: string, text: string) {
  console.log(`Sending message to ${chatId}...`);
  const result = await client.messages.send.mutate({ chatId, text });

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

async function cmdSync(client: Client, chatId: string, maxMessages?: number) {
  console.log(`Syncing messages for chat ${chatId}...`);
  const result = await client.messages.sync.mutate({ chatId, maxMessages });
  console.log(`Synced ${result.count} messages.`);
}

async function cmdScreenshot(client: Client, outputPath: string) {
  console.log(`Capturing screenshot...`);
  const result = await client.debug.screenshot.query();
  const buffer = Buffer.from(result.base64, "base64");
  fs.writeFileSync(outputPath, buffer);
  console.log(`Screenshot saved to ${outputPath}`);
}

async function cmdA11y(client: Client, scope: "chats" | "messages" | "buttons" | "full") {
  const result = await client.debug.a11y.query({ scope });
  if (result.error) {
    console.error(`Error: ${result.error}`);
  }
  console.log(JSON.stringify(result.items, null, 2));
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
    "-p", `${DEFAULT_PORT}:${DEFAULT_PORT}`,
    "-p", `${VNC_PORT}:${VNC_PORT}`,
    "-v", `${CONTAINER_NAME}-data:/data`,
    "-e", `GOOGLE_GENERATIVE_AI_API_KEY=${process.env.GOOGLE_GENERATIVE_AI_API_KEY || ""}`,
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

async function cmdDev() {
  const image = getImageTag();

  // Stop any existing container first
  try {
    execSync(`docker stop ${CONTAINER_NAME}`, { stdio: "ignore" });
    execSync(`docker rm ${CONTAINER_NAME}`, { stdio: "ignore" });
  } catch {
    // Container doesn't exist, that's fine
  }

  // Check if image exists
  try {
    execSync(`docker image inspect ${image}`, { stdio: "ignore" });
  } catch {
    console.error(`Image ${image} not found.`);
    console.error(`Run 'pnpm build:image:local' first to build the image.`);
    process.exit(1);
  }

  // Check if dist folders exist
  const agentServerDist = path.join(MONOREPO_ROOT, "packages/agent-server/dist");
  const sharedDist = path.join(MONOREPO_ROOT, "packages/shared/dist");

  try {
    execSync(`test -d "${agentServerDist}"`, { stdio: "ignore" });
    execSync(`test -d "${sharedDist}"`, { stdio: "ignore" });
  } catch {
    console.error("dist/ folders not found. Run 'pnpm build' first.");
    process.exit(1);
  }

  const dockerToolsDir = path.join(MONOREPO_ROOT, "docker/tools");

  console.log(`Starting container ${CONTAINER_NAME} in dev mode...`);
  console.log(`  Mounting: ${agentServerDist}`);
  console.log(`  Mounting: ${sharedDist}`);
  console.log(`  Mounting: ${dockerToolsDir}`);

  const dockerArgs = [
    "run", "-d",
    "--name", CONTAINER_NAME,
    "--security-opt", "seccomp=unconfined",
    "-p", `${DEFAULT_PORT}:${DEFAULT_PORT}`,
    "-p", `${VNC_PORT}:${VNC_PORT}`,
    "-p", `${DEBUG_PORT}:${DEBUG_PORT}`,
    "-v", `${CONTAINER_NAME}-data:/data`,
    "-v", `${agentServerDist}:/opt/agent-server/dist`,
    "-v", `${sharedDist}:/opt/shared/dist`,
    "-v", `${dockerToolsDir}:/opt/tools`,
    "-e", `GOOGLE_GENERATIVE_AI_API_KEY=${process.env.GOOGLE_GENERATIVE_AI_API_KEY || ""}`,
    "-e", `NODE_OPTIONS=--inspect=0.0.0.0:${DEBUG_PORT}`,
    "-e", "DEV_MODE=1",
    image,
  ];

  try {
    execSync(`docker ${dockerArgs.join(" ")}`, { stdio: "inherit" });
    console.log(`\nDev container started!`);
    console.log(`  API: http://localhost:${DEFAULT_PORT}`);
    console.log(`  VNC: localhost:${VNC_PORT}`);
    console.log(`  Debug: localhost:${DEBUG_PORT}`);
    console.log(`\nWaiting for server to be ready...`);

    for (let i = 0; i < 30; i++) {
      try {
        const response = await fetch(`http://localhost:${DEFAULT_PORT}/health`);
        if (response.ok) {
          console.log("Server is ready!");
          console.log(`\nDev mode active:`);
          console.log(`  - Run 'pnpm build:watch' for hot reload`);
          console.log(`  - Attach VS Code debugger to port ${DEBUG_PORT}`);
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
    console.error("Failed to start dev container:", error);
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
