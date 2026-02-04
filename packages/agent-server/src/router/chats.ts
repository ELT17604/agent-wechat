import { z } from "zod";
import { observable } from "@trpc/server/observable";
import { router, publicProcedure } from "./trpc.js";
import {
  listChatsParamsSchema,
  findChatParamsSchema,
  getChatParamsSchema,
  openChatParamsSchema,
} from "@thisnick/agent-wechat-shared";
import { getChatsFromDb, getChatFromDb, findChatsByName } from "../db/queries.js";
import { getDb } from "../db/index.js";
import { createContext } from "../context/index.js";
import { createExecution, runExecution } from "../execution/index.js";
import { syncChatsPlan, authStatusPlan } from "../plans/index.js";
import type { Chat, SyncSubscriptionEvent } from "@thisnick/agent-wechat-shared";

export const chatsRouter = router({
  /**
   * List all chats from database
   */
  list: publicProcedure
    .input(listChatsParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat[]> => {
      return getChatsFromDb(ctx.db, input.limit, input.unreadOnly);
    }),

  /**
   * Get a specific chat by ID
   */
  get: publicProcedure
    .input(getChatParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat | null> => {
      return getChatFromDb(ctx.db, input.id);
    }),

  /**
   * Find chats by name
   */
  find: publicProcedure
    .input(findChatParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat[]> => {
      return findChatsByName(ctx.db, input.name);
    }),

  /**
   * Open a chat - TODO: implement via FSM plan
   */
  open: publicProcedure
    .input(openChatParamsSchema)
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      // TODO: Implement via openChatPlan
      throw new Error("Not implemented - use FSM plan");
    }),

  /**
   * Sync chats via FSM - scrolls through chat list and syncs to DB
   * Returns a subscription for progress updates
   */
  syncSubscription: publicProcedure
    .input(
      z.object({
        maxChats: z.number().default(20),
        timeoutMs: z.number().default(300_000), // 5 min default (selection-based is slower)
      })
    )
    .subscription(({ input, ctx }) => {
      return observable<SyncSubscriptionEvent>((emit) => {
        const session = ctx.session;

        // No session available
        if (!session) {
          emit.next({ type: "error", message: "No session specified" });
          emit.complete();
          return () => {};
        }

        // AbortController combines: WS disconnect + timeout
        const abortController = new AbortController();
        const { signal: abortSignal } = abortController;

        // Timeout triggers abort
        const timeoutId = setTimeout(() => {
          abortController.abort();
        }, input.timeoutMs);

        const run = async () => {
          try {
            // Get drizzle db for FSM context
            const db = getDb();

            // Create FSM context
            const context = await createContext(session, db);

            // Check login status first
            const authExecution = createExecution(
              authStatusPlan,
              {},
              context,
              { emit: () => {}, abortSignal }
            );
            await runExecution(authExecution);

            if (!context.state.mainWindow.isLoggedIn) {
              emit.next({ type: "error", message: "Not logged in. Run 'pnpm cli auth login' first." });
              emit.complete();
              return;
            }

            // Create execution
            const execution = createExecution(
              syncChatsPlan,
              { maxChats: input.maxChats },
              context,
              {
                emit: (event) => {
                  if (!abortSignal.aborted) {
                    emit.next(event as SyncSubscriptionEvent);
                  }
                },
                abortSignal,
              }
            );

            // Run FSM execution
            emit.next({ type: "status", message: "Starting chat list sync..." });
            const result = await runExecution(execution);

            if (execution.status === "aborted") {
              emit.next({ type: "error", message: "Sync timed out" });
            } else if (result.success) {
              // Get final count of synced chats
              const chats = getChatsFromDb(db);
              emit.next({ type: "sync_complete", count: chats.length });
            } else {
              emit.next({ type: "error", message: result.error || "Sync failed" });
            }
            emit.complete();
          } catch (error) {
            if (!abortSignal.aborted) {
              emit.next({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
              emit.complete();
            }
          }
        };

        run();

        // Cleanup: WS disconnect triggers abort
        return () => {
          clearTimeout(timeoutId);
          abortController.abort();
        };
      });
    }),
});
