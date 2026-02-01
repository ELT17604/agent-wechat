import { generateText, wrapLanguageModel, stepCountIs, Output } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { observe } from "./tools/observe.js";
import { computerUse } from "./tools/computer-use.js";
import { emitStatus } from "./tools/emit-status.js";
import { waitForQrCode } from "./tools/wait-for-qr.js";
import { geminiImageMiddleware } from "./middleware.js";
import type { AgentContext, LoginOptions } from "./context.js";

// Model setup - wrap with middleware to handle images in tool results
const baseModel = google("gemini-3-flash-preview");
const model = wrapLanguageModel({
  model: baseModel,
  middleware: geminiImageMiddleware,
});

// Structured output schema for login result
const LoginResultSchema = z.object({
  success: z.boolean().describe("Whether login was successful"),
  error: z.string().optional().describe("Error message if login failed"),
});

export type LoginResult = z.infer<typeof LoginResultSchema>;

// Login tools
const loginTools = {
  observe,
  computerUse,
  emitStatus,
  waitForQrCode,
};

// System prompt for the login agent
const LOGIN_SYSTEM_PROMPT = (options: LoginOptions) => `You are logging into WeChat desktop on Linux.
${options.newAccount ? "\n**IMPORTANT: User wants to log in with a NEW/DIFFERENT account. If you see an existing account (State B), click 'Switch Account' to get to the QR code screen.**\n" : ""}
## Screen Info
- Screen size: 1280x800 pixels
- All coordinates are in absolute pixels

## States
A: QR code screen (fresh login or after Switch Account)
B: Account confirmation screen ("Enter WeChat" button visible, may also have "Switch Account")
C: Logged in (WeChat main window visible) → SUCCESS
D: Login failed (error dialog with OK button)
E: Phone confirmation screen ("Confirm login on your phone")
P: Popup/overlay dialog (error message, "signed out" notice, etc. with OK/Confirm button)
   - These popups OVERLAY the underlying login screen
   - You MUST dismiss them first by clicking OK before you can interact with the login flow

## Transitions
- Initial state: A, B, or P (popup may appear on top)
- P → A/B (click OK to dismiss popup, reveals underlying screen)
- A → E (user scans QR → phone confirmation)
- B → spinner → C (click "Enter WeChat" → success)
- B → A (click "Switch Account" to log in with different account)
- E → C (user confirms on phone → success)
- E → D (user rejects or timeout → failed)
- D → A (click OK → back to QR screen)

## Tools
- observe: Returns screenshot + accessibility tree with element bounds (x, y, width, height in pixels)
- computerUse: { action: "left_click", coordinate: [x, y] } - click at pixel coordinates
- waitForQrCode: Monitor QR code, send to user's terminal, return when QR disappears
- emitStatus: Send status message to user (for error notifications)

## How to Click
Use bounds from the accessibility tree:
  click_x = bounds.x + bounds.width/2
  click_y = bounds.y + bounds.height/2
ALWAYS use integer coordinates.

## Instructions
1. Use observe (with scope="desktop" to see all windows) to see current state
2. If State P (popup/overlay visible - look for dialogs with OK/Confirm buttons overlaying content):
   a. Find the OK/Confirm button in the a11y tree
   b. Click it using coordinates from bounds
   c. Observe again to see underlying screen
3. If State C (WeChat main window visible, chat list exists): return { success: true }
4. If State D (error dialog):
   a. Click OK button
   b. Use emitStatus to notify user of the error
   c. Observe to check we're back at A
   d. If back at A: continue with waitForQrCode (retry the flow)
   e. If NOT back at A (unexpected state): return { success: false, error: "..." }
5. If State B:
   ${options.newAccount ? "a. Click 'Switch Account' to get to QR code screen\n   b. Observe to confirm we're at State A" : "a. Click 'Enter WeChat' to log in with existing account\n   b. Wait briefly, then observe"}
6. If State A: call waitForQrCode, then observe to see result (should be E)
7. If State E: wait for user to confirm on phone, observe periodically to check
8. Loop until logged in or unrecoverable error

Always use observe after any action to see the result.`;

/**
 * Run the login agent to navigate WeChat's login flow.
 * Returns structured output with success/error status.
 */
export async function runLoginAgent(context: AgentContext): Promise<LoginResult> {
  const loginOptions = context.loginOptions ?? {};

  try {
    const result = await generateText({
      model,
      tools: loginTools,
      stopWhen: stepCountIs(50),
      system: LOGIN_SYSTEM_PROMPT(loginOptions),
      prompt: "Log into WeChat. Start by using observe (with scope='desktop') to see the current state.",
      output: Output.object({ schema: LoginResultSchema }),
      abortSignal: context.abortSignal,
      experimental_context: context,
      onStepFinish: (stepResult) => {
        // Log transcript for debugging
        console.log(`[LoginAgent] Step finished`);
        if (stepResult.text) {
          const text = stepResult.text;
          console.log(`[LoginAgent] Text: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
        }
        if (stepResult.toolCalls?.length) {
          for (const tc of stepResult.toolCalls) {
            // In v6, toolCall has toolName and input properties
            const toolName = "toolName" in tc ? tc.toolName : "unknown";
            const input = "input" in tc ? tc.input : {};
            console.log(`[LoginAgent] Tool: ${toolName}(${JSON.stringify(input)})`);
          }
        }
        if (stepResult.toolResults?.length) {
          for (const tr of stepResult.toolResults) {
            // In v6, toolResult has output property
            const resultOutput = "output" in tr ? tr.output : tr;
            const resultStr = JSON.stringify(resultOutput);
            const truncated =
              resultStr.length > 200 ? resultStr.slice(0, 200) + "..." : resultStr;
            console.log(`[LoginAgent] Result: ${truncated}`);
          }
        }
      },
    });

    // Log final result
    console.log(`[LoginAgent] Final: ${JSON.stringify(result.output)}`);
    console.log(`[LoginAgent] Steps: ${result.steps.length}, Usage: ${JSON.stringify(result.usage)}`);

    return result.output ?? { success: false, error: "No output from agent" };
  } catch (error) {
    // Handle abort
    if (error instanceof Error && error.name === "AbortError") {
      console.log("[LoginAgent] Aborted");
      return { success: false, error: "Login aborted" };
    }

    console.error("[LoginAgent] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
