import { tool, ToolExecutionOptions } from "ai";
import { z } from "zod";
import { captureScreenshot } from "../../lib/screenshot.js";
import { decodeQrFromBase64 } from "../../lib/qr.js";
import type { AgentContext } from "../context.js";

/**
 * Wait for QR code tool - monitors the screen for a QR code and emits it to the user.
 * Polls the screen, decodes QR codes, and sends them via WebSocket.
 * Returns when the QR code disappears (user scanned it) or is aborted.
 */
export const waitForQrCode = tool({
  description:
    "Monitor the QR code on screen. This will send the QR code to the user's terminal and wait until it disappears (user scanned it) or times out. After this returns, use observe to check the new state.",
  inputSchema: z.object({}),
  execute: async (_params: Record<string, never>, options: ToolExecutionOptions) => {
    const { session, emit, abortSignal } = options.experimental_context as AgentContext;

    let lastQrData: string | null = null;
    const pollIntervalMs = 1000;

    while (!abortSignal.aborted) {
      try {
        // Capture screenshot
        const screenshot = await captureScreenshot({ session });

        // Try to decode QR code
        const qrData = await decodeQrFromBase64(screenshot);

        if (!qrData) {
          // No QR code found
          if (lastQrData === null) {
            // Never found a QR code
            return {
              status: "no_qr",
              message: "No QR code found on screen. Use observe to check the current state.",
            };
          }

          // QR code disappeared (user scanned it or it expired)
          return {
            status: "qr_gone",
            message: "QR code disappeared. Use observe to check if login succeeded or failed.",
          };
        }

        // QR code found - emit if new or changed
        if (qrData !== lastQrData) {
          emit({ type: "qr", qrData });
          lastQrData = qrData;
        }

        // Wait for next poll, but abort early if signal fires
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, pollIntervalMs)),
          new Promise((resolve) =>
            abortSignal.addEventListener("abort", resolve, { once: true })
          ),
        ]);
      } catch (error) {
        // Screenshot or decode error - try again
        console.error("[waitForQrCode] Error during poll:", error);

        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, pollIntervalMs)),
          new Promise((resolve) =>
            abortSignal.addEventListener("abort", resolve, { once: true })
          ),
        ]);
      }
    }

    return {
      status: "aborted",
      message: "Login cancelled or timed out.",
    };
  },
});
