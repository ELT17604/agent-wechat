import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";
import {
  listChatsParamsSchema,
  findChatParamsSchema,
  getChatParamsSchema,
  openChatParamsSchema,
} from "@thisnick/agent-wechat-shared";
import { runListChatsAgent, runFindChatAgent, runOpenChatAgent } from "../agent/index.js";
import { getChatsFromDb, getChatFromDb } from "../db/queries.js";
import type { Chat } from "@thisnick/agent-wechat-shared";

export const chatsRouter = router({
  /**
   * List all chats (from database, synced via agent)
   */
  list: publicProcedure
    .input(listChatsParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat[]> => {
      // First try to get from database
      const dbChats = getChatsFromDb(ctx.db, input.limit, input.unreadOnly);

      // If database is empty, run agent to sync
      if (dbChats.length === 0) {
        await runListChatsAgent();
        return getChatsFromDb(ctx.db, input.limit, input.unreadOnly);
      }

      return dbChats;
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
   * Find chats by name (uses agent if not in database)
   */
  find: publicProcedure
    .input(findChatParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat[]> => {
      // First check database
      const dbResult = await import("../db/queries.js").then((m) =>
        m.findChatsByName(ctx.db, input.name)
      );

      if (dbResult.length > 0) {
        return dbResult;
      }

      // If not found, use agent to search
      const agentResult = await runFindChatAgent(input.name);
      return agentResult;
    }),

  /**
   * Open a chat (navigate to it in WeChat)
   */
  open: publicProcedure
    .input(openChatParamsSchema)
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      const result = await runOpenChatAgent(input.id);
      return { success: result.success };
    }),

  /**
   * Sync chats from WeChat UI to database
   */
  sync: publicProcedure.mutation(async (): Promise<{ count: number }> => {
    const chats = await runListChatsAgent();
    return { count: chats.length };
  }),
});
