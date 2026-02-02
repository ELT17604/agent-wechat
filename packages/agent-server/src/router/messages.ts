import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";
import {
  sendParamsSchema,
  getMessagesParamsSchema,
  downloadAttachmentParamsSchema,
} from "@thisnick/agent-wechat-shared";
import { getMessagesFromDb, getMessageFromDb } from "../db/queries.js";
import fs from "fs/promises";
import type { Message, SendResult, DownloadAttachmentResult } from "@thisnick/agent-wechat-shared";

export const messagesRouter = router({
  /**
   * Send a message - TODO: implement via FSM plan
   */
  send: publicProcedure
    .input(sendParamsSchema)
    .mutation(async ({ input }): Promise<SendResult> => {
      // TODO: Implement via sendMessagePlan
      throw new Error("Not implemented - use FSM plan");
    }),

  /**
   * Get messages from a chat
   */
  get: publicProcedure
    .input(getMessagesParamsSchema)
    .query(async ({ input, ctx }): Promise<Message[]> => {
      return getMessagesFromDb(ctx.db, input.chatId, input.limit, input.since);
    }),

  /**
   * Sync messages - TODO: implement via FSM plan
   */
  sync: publicProcedure
    .input(z.object({
      chatId: z.string(),
      maxMessages: z.number().default(50),
    }))
    .mutation(async ({ input }): Promise<{ count: number }> => {
      // TODO: Implement via getMessagesPlan
      throw new Error("Not implemented - use FSM plan");
    }),

  /**
   * Download attachment for a message
   */
  download: publicProcedure
    .input(downloadAttachmentParamsSchema)
    .query(async ({ input, ctx }): Promise<DownloadAttachmentResult> => {
      const message = getMessageFromDb(ctx.db, input.messageId);

      if (!message) {
        throw new Error("Message not found");
      }

      if (!message.isDownloaded || !message.downloadPath) {
        throw new Error("Attachment not downloaded");
      }

      try {
        const buffer = await fs.readFile(message.downloadPath);
        const base64 = buffer.toString("base64");

        const ext = message.downloadPath.split(".").pop()?.toLowerCase() || "";
        const mimeTypes: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          mp4: "video/mp4",
          mp3: "audio/mpeg",
          pdf: "application/pdf",
        };

        return {
          base64,
          mimeType: mimeTypes[ext] || "application/octet-stream",
          filename: message.downloadPath.split("/").pop(),
        };
      } catch (error) {
        throw new Error(`Failed to read attachment: ${error}`);
      }
    }),
});
