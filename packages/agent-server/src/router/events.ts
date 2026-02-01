import { observable } from "@trpc/server/observable";
import { router, publicProcedure } from "./trpc.js";
import type { ServerEvent } from "@thisnick/agent-wechat-shared";

// Event emitter for real-time events
type EventCallback = (event: ServerEvent) => void;
const subscribers: Set<EventCallback> = new Set();

export function emitEvent(event: ServerEvent) {
  for (const callback of subscribers) {
    callback(event);
  }
}

export const eventsRouter = router({
  /**
   * Subscribe to real-time events (messages, login state changes, etc.)
   */
  subscribe: publicProcedure.subscription(() => {
    return observable<ServerEvent>((emit) => {
      const callback: EventCallback = (event) => {
        emit.next(event);
      };

      subscribers.add(callback);

      return () => {
        subscribers.delete(callback);
      };
    });
  }),
});
