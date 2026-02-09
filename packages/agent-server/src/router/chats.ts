import { router, publicProcedure } from "./trpc.js";
import {
  listChatsParamsSchema,
  findChatParamsSchema,
  getChatParamsSchema,
  openChatParamsSchema,
} from "@thisnick/agent-wechat-shared";
import type { Chat } from "@thisnick/agent-wechat-shared";
import { getStoredKeys } from "../lib/wechat-keys.js";
import { listChatsFromWechatDb, getChatByUsername, findChatsByName } from "../lib/wechat-chats.js";
import { openChat } from "../lib/chat-select.js";

export const chatsRouter = router({
  /**
   * List chats from WeChat databases
   */
  list: publicProcedure
    .input(listChatsParamsSchema)
    .query(async ({ input, ctx }): Promise<Chat[]> => {
      const session = ctx.session;
      if (!session?.loggedInUser) return [];

      const keys = getStoredKeys(ctx.db, session.id, session.loggedInUser);
      if (!keys["session.db"] || !keys["contact.db"]) return [];

      return listChatsFromWechatDb(session.loggedInUser, keys, input.limit, input.offset);
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

  /**
   * Open a chat in WeChat UI (triggers media downloads + clears unread)
   */
  open: publicProcedure
    .input(openChatParamsSchema)
    .mutation(async ({ input, ctx }) => {
      return await openChat(input.chatId, { session: ctx.session });
    }),
});
