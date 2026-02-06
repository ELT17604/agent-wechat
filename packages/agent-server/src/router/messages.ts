import { router, publicProcedure } from "./trpc.js";
import {
  sendParamsSchema,
} from "@thisnick/agent-wechat-shared";
import type { SendResult } from "@thisnick/agent-wechat-shared";

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
});
