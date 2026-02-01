import { tool, ToolExecutionOptions } from "ai";
import { z } from "zod";
import { execCommand } from "../../lib/exec.js";
import type { AgentContext } from "../context.js";

const inputSchema = z.object({
  action: z.literal("left_click").describe("The action to perform (only left_click supported)"),
  coordinate: z.array(z.number()).describe("Screen coordinates [x, y] to click at"),
});

type ComputerUseInput = z.infer<typeof inputSchema>;

/**
 * Computer use tool - performs clicks at screen coordinates.
 * Uses wechat-click which wraps xdotool for X11 interaction.
 */
export const computerUse = tool({
  description:
    "Click at screen coordinates. Use the observe tool first to get element positions from the accessibility tree, then click at the center of the target element.",
  inputSchema,
  execute: async ({ coordinate }: ComputerUseInput, options: ToolExecutionOptions) => {
    const { session } = options.experimental_context as AgentContext;
    const [x, y] = coordinate;

    // wechat-click is a bash wrapper that calls: xdotool mousemove X Y click 1
    const result = await execCommand("wechat-click", [String(x), String(y)], { session });

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr || "Click failed",
      };
    }

    return {
      success: true,
      message: `Clicked at (${x}, ${y})`,
    };
  },
});
