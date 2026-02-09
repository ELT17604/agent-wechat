import { router, publicProcedure } from "./trpc.js";
import {
  sendParamsSchema,
  listMessagesParamsSchema,
  getMediaParamsSchema,
} from "@thisnick/agent-wechat-shared";
import type { SendResult, Message, MediaResult } from "@thisnick/agent-wechat-shared";
import { getStoredKeys, getImageKeys, storeSingleKey } from "../lib/wechat-keys.js";
import { listMessagesFromWechatDb } from "../lib/wechat-messages.js";
import { getMessageMedia } from "../lib/wechat-media.js";

export const messagesRouter = router({
  /**
   * List messages for a specific chat
   */
  list: publicProcedure
    .input(listMessagesParamsSchema)
    .query(async ({ input, ctx }): Promise<Message[]> => {
      const session = ctx.session;
      if (!session?.loggedInUser) return [];

      const keys = getStoredKeys(ctx.db, session.id, session.loggedInUser);
      if (!keys["message_0.db"]) return [];

      return listMessagesFromWechatDb(session.loggedInUser, keys, input.chatId, input.limit, input.offset);
    }),

  /**
   * Get media attachment for a message (image thumbnail, emoji, or voice)
   */
  media: publicProcedure
    .input(getMediaParamsSchema)
    .query(async ({ input, ctx }): Promise<MediaResult> => {
      const session = ctx.session;
      if (!session?.loggedInUser) return { type: "unsupported", format: "", filename: "" };

      const accountDir = session.loggedInUser;
      const keys = getStoredKeys(ctx.db, session.id, accountDir);
      const imageKeys = getImageKeys(ctx.db, session.id, accountDir);
      return getMessageMedia(accountDir, keys, input.chatId, input.localId, imageKeys,
        (xorByte) => storeSingleKey(ctx.db, session.id, accountDir, "_image_xor", xorByte.toString(16).padStart(2, "0")),
      );
    }),

  /**
   * Send a message - TODO: implement via FSM plan
   */
  send: publicProcedure
    .input(sendParamsSchema)
    .mutation(async ({ input }): Promise<SendResult> => {
      // TODO: Implement via sendMessagePlan
      throw new Error("Not implemented - use FSM plan");
    }),
});
