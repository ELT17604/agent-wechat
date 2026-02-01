import { router } from "./trpc.js";
import { statusRouter } from "./status.js";
import { chatsRouter } from "./chats.js";
import { messagesRouter } from "./messages.js";
import { eventsRouter } from "./events.js";
import { debugRouter } from "./debug.js";
import { sessionsRouter } from "./sessions.js";

// Create the merged router (not exported directly to avoid declaration issues)
const _appRouter = router({
  status: statusRouter,
  chats: chatsRouter,
  messages: messagesRouter,
  events: eventsRouter,
  debug: debugRouter,
  sessions: sessionsRouter,
});

// Export only the type for client usage
export type AppRouter = typeof _appRouter;

// Export a function to get the router (for server.ts use)
export function getAppRouter() {
  return _appRouter;
}
