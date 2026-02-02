import { tool, ToolExecutionOptions } from "ai";
import { z } from "zod";
import { captureScreenshot } from "../../lib/screenshot.js";
import { getA11yAria } from "../../lib/a11y.js";
import type { AgentContext } from "../context.js";

/**
 * Extract width and height from a PNG image (base64 encoded).
 * PNG stores dimensions in the IHDR chunk at bytes 16-23.
 */
function getPngDimensions(base64: string): { width: number; height: number } {
  const buffer = Buffer.from(base64, "base64");
  // PNG IHDR chunk: width at bytes 16-19, height at bytes 20-23 (big-endian)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

interface ObserveOutput {
  imageBase64: string;
  imageWidth: number;
  imageHeight: number;
  a11yTree: string;
  error?: string;
}

/**
 * Observe tool - returns screenshot and accessibility tree for UI navigation.
 * The LLM uses this to understand the current state of the WeChat window.
 */
export const observe = tool({
  description:
    "Observe the screen. Returns a screenshot and accessibility tree with element positions (x, y, width, height in pixels). Use this to understand the current UI state before taking actions.",
  inputSchema: z.object({
    scope: z.enum(["wechat", "desktop"]).default("desktop").describe(
      "Scope of accessibility tree: 'wechat' for WeChat app only, 'desktop' for all windows (useful during login)"
    ),
  }),
  execute: async (params: { scope?: "wechat" | "desktop" }, options: ToolExecutionOptions): Promise<ObserveOutput> => {
    const { session } = options.experimental_context as AgentContext;
    const scope = params.scope ?? "desktop";

    // Capture screenshot
    const imageBase64 = await captureScreenshot({ session });

    // Get actual dimensions from the PNG
    const { width, height } = getPngDimensions(imageBase64);

    // Get accessibility tree in ARIA format (nested, human-readable)
    // Note: The a11y script now only outputs desktop scope
    const a11y = await getA11yAria({ session });

    return {
      imageBase64,
      imageWidth: width,
      imageHeight: height,
      a11yTree: a11y.tree,
      error: a11y.error,
    };
  },
  toModelOutput({ output }: { toolCallId: string; input: { scope?: "wechat" | "desktop" }; output: ObserveOutput }) {
    const content: Array<
      | { type: "image-data"; data: string; mediaType: string }
      | { type: "text"; text: string }
    > = [];

    // Add image
    content.push({
      type: "image-data",
      data: output.imageBase64,
      mediaType: "image/png",
    });

    // Add a11y tree as text with image dimensions
    let text = `Screenshot: ${output.imageWidth}x${output.imageHeight} pixels

Accessibility tree (bounds format: @(x,y widthxheight)):
To click an element, use center of its bounds: x + width/2, y + height/2

${output.a11yTree}`;
    if (output.error) {
      text += `\n\nWarning: ${output.error}`;
    }
    content.push({ type: "text", text });

    return { type: "content" as const, value: content };
  },
});
