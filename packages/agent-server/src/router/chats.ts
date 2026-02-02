import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";
import {
  listChatsParamsSchema,
  findChatParamsSchema,
  getChatParamsSchema,
  openChatParamsSchema,
} from "@thisnick/agent-wechat-shared";
import { getChatsFromDb, getChatFromDb, findChatsByName } from "../db/queries.js";
import type { Chat } from "@thisnick/agent-wechat-shared";

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
   * Sync chats - TODO: implement via FSM plan
   */
  sync: publicProcedure.mutation(async (): Promise<{ count: number }> => {
    // TODO: Implement via listChatsPlan
    throw new Error("Not implemented - use FSM plan");
  }),
});
