#!/usr/bin/env node

import { createClient, createSubscriptionClient, Client, ClientOptions } from "./lib/client.js";
import { spawn, execSync } from "child_process";
import fs from "fs";
import qrTerminal from "qrcode-terminal";
import os from "os";

import path from "path";
import { fileURLToPath } from "url";

const VERSION = "0.1.0";
const CONTAINER_NAME = "wx";
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
  if (arch === "arm64") return "wx:arm64";
  return "wx:amd64";
}

function printHelp() {
  console.log(`
wx CLI v${VERSION}

Usage: wx [--session <name>] <command> [options]

Global Options:
  --session <name>    Use specified session (default: "default")

Container Commands:
  up                  Start the WeChat container (production mode)
  dev                 Start in dev mode (hot reload + debugging)
  down                Stop and remove the container
  logs                Show container logs

Session Commands:
  session list        List all sessions
  session create <n>  Create a new session
  session start <n>   Start a session
  session stop <n>    Stop a session
  session delete <n>  Delete a session

API Commands (use with --session to target specific session):
  status              Show container and login status
  login [options]     Log in to WeChat (shows QR code)
                      --timeout N  Timeout in seconds (default: 300)
                      --new        Switch to new account instead of existing
  chats [limit]       List chats
  find <name>         Find chat by name
  messages <chatId>   Get messages from a chat
  send <chatId> <msg> Send a message to a chat
  sync <chatId>       Sync messages from WeChat UI

Debug Commands:
  screenshot [file]   Save screenshot to file (default: screenshot.png)
  a11y [scope]        Dump accessibility tree (chats|messages|buttons|full|desktop)

Environment Variables:
  AGENT_WECHAT_URL    Server URL (default: http://localhost:${DEFAULT_PORT})
  AGENT_WECHAT_TOKEN  Authentication token (optional)

Examples:
  pnpm cli session list              # List all sessions
  pnpm cli session create work       # Create session named "work"
  pnpm cli --session work login      # Login to work session
  pnpm cli --session work chats      # List chats in work session

Development:
  1. Run 'pnpm build:watch' in one terminal
  2. Run 'pnpm cli dev' in another terminal
  3. Attach VS Code debugger to port ${DEBUG_PORT}
  4. VNC viewer: localhost:${VNC_PORT}
`);
}

async function main() {
  let args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    process.exit(0);
  }

  // Parse --session flag
  let sessionId: string | undefined;
  const sessionIdx = args.indexOf("--session");
  if (sessionIdx !== -1 && args[sessionIdx + 1]) {
    sessionId = args[sessionIdx + 1];
    args = [...args.slice(0, sessionIdx), ...args.slice(sessionIdx + 2)];
  }

  const config = getConfig();
  const clientOptions: ClientOptions = { url: config.serverUrl, token: config.token, sessionId };
  const client = createClient(clientOptions);

  const command = args[0];

  try {
    // Container commands don't need client
    switch (command) {
      case "up":
        await cmdUp();
        return;
      case "dev":
        await cmdDev();
        return;
      case "down":
        await cmdDown();
        return;
      case "logs":
        await cmdLogs();
        return;
    }

    // Session commands
    if (command === "session") {
      const subcommand = args[1];
      switch (subcommand) {
        case "list":
          await cmdSessionList(client);
          return;
        case "create":
          if (!args[2]) {
            console.error("Usage: wx session create <name>");
            process.exit(1);
          }
          await cmdSessionCreate(client, args[2]);
          return;
        case "start":
          if (!args[2]) {
            console.error("Usage: wx session start <id|name>");
            process.exit(1);
          }
          await cmdSessionStart(client, args[2]);
          return;
        case "stop":
          if (!args[2]) {
            console.error("Usage: wx session stop <id|name>");
            process.exit(1);
          }
          await cmdSessionStop(client, args[2]);
          return;
        case "delete":
          if (!args[2]) {
            console.error("Usage: wx session delete <id|name>");
            process.exit(1);
          }
          await cmdSessionDelete(client, args[2]);
          return;
        default:
          console.error(`Unknown session subcommand: ${subcommand}`);
          console.error("Available: list, create, start, stop, delete");
          process.exit(1);
      }
    }

    // API commands need client
    switch (command) {
      case "status":
        await cmdStatus(client);
        break;
      case "login": {
        // Parse --timeout option (in seconds)
        const timeoutIdx = args.indexOf("--timeout");
        let timeoutMs = 300_000; // 5 min default
        if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
          timeoutMs = parseInt(args[timeoutIdx + 1], 10) * 1000;
        }
        // Parse --new flag (switch to new account instead of using existing)
        const newAccount = args.includes("--new");
        await cmdLogin(clientOptions, timeoutMs, newAccount);
        break;
      }
      case "chats":
        await cmdChats(client, args[1] ? parseInt(args[1], 10) : undefined);
        break;
      case "find":
        if (!args[1]) {
          console.error("Usage: wx find <name>");
          process.exit(1);
        }
        await cmdFind(client, args[1]);
        break;
      case "messages":
        if (!args[1]) {
          console.error("Usage: wx messages <chatId> [limit]");
          process.exit(1);
        }
        await cmdMessages(client, args[1], args[2] ? parseInt(args[2], 10) : undefined);
        break;
      case "send":
        if (!args[1] || !args[2]) {
          console.error("Usage: wx send <chatId> <message>");
          process.exit(1);
        }
        await cmdSend(client, args[1], args.slice(2).join(" "));
        break;
      case "sync":
        if (!args[1]) {
          console.error("Usage: wx sync <chatId> [maxMessages]");
          process.exit(1);
        }
        await cmdSync(client, args[1], args[2] ? parseInt(args[2], 10) : undefined);
        break;
      case "screenshot":
        await cmdScreenshot(client, args[1]);
        break;
      case "a11y":
        await cmdA11y(client, args[1] as "chats" | "messages" | "buttons" | "full" | undefined);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("An unexpected error occurred");
    }
    process.exit(1);
  }
}

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
                qrTerminal.generate(event.qrData, { small: true });
                console.log("\nWaiting for scan... (Ctrl+C to cancel)\n");
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

async function cmdScreenshot(client: Client, outputPath?: string) {
  const filePath = outputPath || "screenshot.png";
  console.log(`Capturing screenshot...`);
  const result = await client.debug.screenshot.query();
  const buffer = Buffer.from(result.base64, "base64");
  fs.writeFileSync(filePath, buffer);
  console.log(`Screenshot saved to ${filePath}`);
}

async function cmdA11y(client: Client, scope?: "chats" | "messages" | "buttons" | "full") {
  const result = await client.debug.a11y.query({ scope: scope || "full" });
  if (result.error) {
    console.error(`Error: ${result.error}`);
  }
  console.log(JSON.stringify(result.items, null, 2));
}

// Session management commands

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

// Container management commands

async function cmdUp() {
  const image = getImageTag();

  // Check if container already exists (use exact name match with regex)
  try {
    const existingId = execSync(`docker ps -aq -f "name=^${CONTAINER_NAME}$"`, { encoding: "utf-8" }).trim();
    if (existingId) {
      // Check if it's running
      const running = execSync(`docker ps -q -f "name=^${CONTAINER_NAME}$"`, { encoding: "utf-8" }).trim();
      if (running) {
        console.log(`Container ${CONTAINER_NAME} is already running.`);
        console.log(`API: http://localhost:${DEFAULT_PORT}`);
        console.log(`VNC: localhost:${VNC_PORT}`);
        return;
      }
      // Container exists but not running, start it
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

  // Run container
  const dockerArgs = [
    "run", "-d",
    "--name", CONTAINER_NAME,
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

    // Wait for server to be ready
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
    console.log("\nServer did not become ready in time. Check logs with: wx logs");
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

  // Paths for dev mounts
  const dockerToolsDir = path.join(MONOREPO_ROOT, "docker/tools");

  console.log(`Starting container ${CONTAINER_NAME} in dev mode...`);
  console.log(`  Mounting: ${agentServerDist}`);
  console.log(`  Mounting: ${sharedDist}`);
  console.log(`  Mounting: ${dockerToolsDir}`);

  // Run container with volume mounts and debug port
  const dockerArgs = [
    "run", "-d",
    "--name", CONTAINER_NAME,
    "-p", `${DEFAULT_PORT}:${DEFAULT_PORT}`,
    "-p", `${VNC_PORT}:${VNC_PORT}`,
    "-p", `${DEBUG_PORT}:${DEBUG_PORT}`,
    "-v", `${CONTAINER_NAME}-data:/data`,
    "-v", `${agentServerDist}:/opt/agent-server/dist`,
    "-v", `${sharedDist}:/opt/shared/dist`,
    "-v", `${dockerToolsDir}:/opt/tools`,
    "-e", `GOOGLE_GENERATIVE_AI_API_KEY=${process.env.GOOGLE_GENERATIVE_AI_API_KEY || ""}`,
    "-e", `NODE_OPTIONS=--inspect=0.0.0.0:${DEBUG_PORT}`,
    image,
    "node", "--watch", "/opt/agent-server/dist/index.js",
  ];

  try {
    execSync(`docker ${dockerArgs.join(" ")}`, { stdio: "inherit" });
    console.log(`\nDev container started!`);
    console.log(`  API: http://localhost:${DEFAULT_PORT}`);
    console.log(`  VNC: localhost:${VNC_PORT}`);
    console.log(`  Debug: localhost:${DEBUG_PORT}`);
    console.log(`\nWaiting for server to be ready...`);

    // Wait for server to be ready
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
