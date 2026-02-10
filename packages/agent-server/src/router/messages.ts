import fs from "fs";
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
import { getDb } from "../db/index.js";
import { createContext } from "../context/index.js";
import { createExecution, runExecution } from "../execution/index.js";
import { sendMessagePlan } from "../plans/index.js";

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
   * Send a text message, image, or file via FSM plan
   */
  send: publicProcedure
    .input(sendParamsSchema)
    .mutation(async ({ input, ctx }): Promise<SendResult> => {
      if (!input.text && !input.image && !input.file) {
        return { success: false, error: "No text, image, or file provided" };
      }

      const session = ctx.session;
      if (!session) {
        return { success: false, error: "No session available" };
      }
      if (!session.loggedInUser) {
        return { success: false, error: "NOT_LOGGED_IN" };
      }

      // Decode base64 image to temp file (if provided)
      let imagePath: string | undefined;
      let imageMime: string | undefined;
      if (input.image) {
        const ext = input.image.mimeType === "image/jpeg" ? ".jpg" :
                    input.image.mimeType === "image/gif" ? ".gif" : ".png";
        imagePath = `/tmp/send_image_${Date.now()}${ext}`;
        fs.writeFileSync(imagePath, Buffer.from(input.image.data, "base64"));
        imageMime = input.image.mimeType;
      }

      // Decode base64 file to temp file (if provided)
      let filePath: string | undefined;
      if (input.file) {
        filePath = `/tmp/send_file_${Date.now()}_${input.file.filename}`;
        fs.writeFileSync(filePath, Buffer.from(input.file.data, "base64"));
      }

      try {
        const db = getDb();
        const context = await createContext(session, db);

        const execution = createExecution(
          sendMessagePlan,
          {
            chatId: input.chatId,
            message: input.text,
            imagePath,
            imageMime,
            filePath,
          },
          context,
          {
            emit: () => {},
            abortSignal: ctx.abortSignal,
          }
        );

        const result = await runExecution(execution);
        return { success: result.success, error: result.error };
      } finally {
        // Clean up temp files
        if (imagePath) {
          try { fs.unlinkSync(imagePath); } catch {}
        }
        if (filePath) {
          try { fs.unlinkSync(filePath); } catch {}
        }
      }
    }),
});
