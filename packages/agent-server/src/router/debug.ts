import { router, publicProcedure } from "./trpc.js";
import { captureScreenshot } from "../lib/screenshot.js";
import { getA11yData } from "../lib/a11y.js";
import { z } from "zod";

export const debugRouter = router({
  /**
   * Capture a screenshot and return as base64-encoded PNG
   */
  screenshot: publicProcedure.query(async () => {
    const base64 = await captureScreenshot();
    return { base64 };
  }),

  /**
   * Run a11y dump command
   */
  a11y: publicProcedure
    .input(z.object({ scope: z.enum(["chats", "messages", "buttons", "full"]).default("full") }))
    .query(async ({ input }) => {
      return await getA11yData(input.scope);
    }),
});
