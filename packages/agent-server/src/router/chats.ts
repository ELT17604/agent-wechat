import { router, publicProcedure } from "./trpc.js";
import {
  listChatsParamsSchema,
  findChatParamsSchema,
  getChatParamsSchema,
} from "@thisnick/agent-wechat-shared";
import type { Chat } from "@thisnick/agent-wechat-shared";
import { getStoredKeys } from "../lib/wechat-keys.js";
import { listChatsFromWechatDb, getChatByUsername, findChatsByName } from "../lib/wechat-chats.js";

export const chatsRouter = router({
  /**
   * List chats from WeChat's encrypted session.db + contact.db
   */
  list: publicProcedure
    .input(listChatsParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat[]> => {
      const session = ctx.session;
      if (!session?.loggedInUser) return [];

      const keys = getStoredKeys(ctx.db, session.id, session.loggedInUser);
      if (!keys["session.db"] || !keys["contact.db"]) return [];

      return listChatsFromWechatDb(session.loggedInUser, keys, input.limit);
    }),

  /**
   * Get a specific chat by WeChat username
   */
  get: publicProcedure
    .input(getChatParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat | null> => {
      const session = ctx.session;
      if (!session?.loggedInUser) return null;

      const keys = getStoredKeys(ctx.db, session.id, session.loggedInUser);
      if (!keys["session.db"] || !keys["contact.db"]) return null;

      return getChatByUsername(session.loggedInUser, keys, input.id);
    }),

  /**
   * Find chats by name
   */
  find: publicProcedure
    .input(findChatParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat[]> => {
      const session = ctx.session;
      if (!session?.loggedInUser) return [];

      const keys = getStoredKeys(ctx.db, session.id, session.loggedInUser);
      if (!keys["session.db"] || !keys["contact.db"]) return [];

      return findChatsByName(session.loggedInUser, keys, input.name);
    }),
});
