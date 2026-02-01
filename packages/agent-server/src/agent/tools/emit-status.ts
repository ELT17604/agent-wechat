import { tool, ToolExecutionOptions } from "ai";
import { z } from "zod";
import type { AgentContext } from "../context.js";

const inputSchema = z.object({
  message: z.string().describe("The status message to send to the user"),
});

type EmitStatusInput = z.infer<typeof inputSchema>;

/**
 * Emit status tool - sends a status message to the user via WebSocket.
 * Use this to notify the user about errors, progress, or important state changes.
 */
export const emitStatus = tool({
  description:
    "Send a status message to the user. Use this to notify about errors, progress updates, or important information the user should see.",
  inputSchema,
  execute: async ({ message }: EmitStatusInput, options: ToolExecutionOptions) => {
    const { emit } = options.experimental_context as AgentContext;

    emit({ type: "status", message });

    return {
      success: true,
      message: `Status sent: ${message}`,
    };
  },
});
