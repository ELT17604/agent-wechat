import { createServer } from "http";
import { WebSocketServer } from "ws";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { getAppRouter } from "./router/index.js";
import { createContext } from "./router/context.js";
import { initDb } from "./db/index.js";
import { initializeSessions } from "./sessions/manager.js";

const PORT = parseInt(process.env.AGENT_PORT || "6174", 10);
const HOST = process.env.AGENT_HOST || "0.0.0.0";

async function main() {
  // Log environment for debugging
  console.log("Environment:");
  console.log("  DISPLAY:", process.env.DISPLAY);
  console.log("  DBUS_SESSION_BUS_ADDRESS:", process.env.DBUS_SESSION_BUS_ADDRESS);
  console.log("  QT_ACCESSIBILITY:", process.env.QT_ACCESSIBILITY);

  // Initialize database
  console.log("Initializing database...");
  initDb();

  // Initialize sessions (create default if none exist, restart previously running)
  console.log("Initializing sessions...");
  await initializeSessions();

  // Get the app router
  const appRouter = getAppRouter();

  // Create HTTP handler for tRPC
  const httpHandler = createHTTPHandler({
    router: appRouter,
    createContext,
  });

  // Create HTTP server
  const server = createServer((req, res) => {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Health check endpoint
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
      return;
    }

    // tRPC handler
    httpHandler(req, res);
  });

  // Create WebSocket server for subscriptions
  const wss = new WebSocketServer({ server });
  applyWSSHandler({
    wss,
    router: appRouter,
    createContext,
  });

  // Start server
  server.listen(PORT, HOST, () => {
    console.log(`agent-server listening on http://${HOST}:${PORT}`);
    console.log(`WebSocket available at ws://${HOST}:${PORT}`);
  });

  // Handle shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    wss.close();
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start agent-server:", err);
  process.exit(1);
});
