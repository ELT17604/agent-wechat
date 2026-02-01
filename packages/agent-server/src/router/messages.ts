import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";
import {
  sendParamsSchema,
  getMessagesParamsSchema,
  downloadAttachmentParamsSchema,
} from "@thisnick/agent-wechat-shared";
import { runSendMessageAgent, runGetMessagesAgent } from "../agent/index.js";
import { getMessagesFromDb, getMessageFromDb } from "../db/queries.js";
import { execCommand } from "../lib/exec.js";
import fs from "fs/promises";
import type { Message, SendResult, DownloadAttachmentResult } from "@thisnick/agent-wechat-shared";

export const messagesRouter = router({
  /**
   * Send a message to a chat
   */
  send: publicProcedure
    .input(sendParamsSchema)
    .mutation(async ({ input }): Promise<SendResult> => {
      return runSendMessageAgent(input.chatId, input.text, input.files);
    }),

  /**
   * Get messages from a chat
   */
  get: publicProcedure
    .input(getMessagesParamsSchema)
    .query(async ({ input, ctx }): Promise<Message[]> => {
      // First try database
      const dbMessages = getMessagesFromDb(
        ctx.db,
        input.chatId,
        input.limit,
        input.since
      );

      // If empty, sync from UI
      if (dbMessages.length === 0) {
        await runGetMessagesAgent(input.chatId, input.limit);
        return getMessagesFromDb(ctx.db, input.chatId, input.limit, input.since);
      }

      return dbMessages;
    }),

  /**
   * Sync messages from WeChat UI
   */
  sync: publicProcedure
    .input(z.object({
      chatId: z.string(),
      maxMessages: z.number().default(50),
    }))
    .mutation(async ({ input }): Promise<{ count: number }> => {
      const messages = await runGetMessagesAgent(input.chatId, input.maxMessages);
      return { count: messages.length };
    }),

  /**
   * Download attachment for a message
   */
  download: publicProcedure
    .input(downloadAttachmentParamsSchema)
    .query(async ({ input, ctx }): Promise<DownloadAttachmentResult> => {
      // Get message from database to find download path
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

        // Detect mime type from extension
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
