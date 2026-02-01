import { z } from "zod";
import { observable } from "@trpc/server/observable";
import { router, publicProcedure } from "./trpc.js";
import { runA11yProbe } from "../lib/a11y.js";
import { captureScreenshot } from "../lib/screenshot.js";
import { decodeQrFromBase64, toDataURL } from "../lib/qr.js";
import { runLoginAgent } from "../agent/login.js";
import type { AgentContext } from "../agent/context.js";
import type { LoginState, Status, LoginSubscriptionEvent } from "@thisnick/agent-wechat-shared";

export const statusRouter = router({
  /**
   * Get current container and login status
   */
  get: publicProcedure.query(async ({ ctx }): Promise<Status> => {
    try {
      const probe = await runA11yProbe({ session: ctx.session });

      let loginState: LoginState;
      if (probe.loggedIn) {
        loginState = { status: "logged_in" };
      } else {
        loginState = { status: "qr_pending" };
      }

      return {
        container: "running",
        loginState,
        version: "0.1.0",
      };
    } catch {
      return {
        container: "running",
        loginState: { status: "logged_out" },
        version: "0.1.0",
      };
    }
  }),

  /**
   * Get login state
   */
  getLoginState: publicProcedure.query(async ({ ctx }): Promise<LoginState> => {
    try {
      const probe = await runA11yProbe({ session: ctx.session });

      if (probe.loggedIn) {
        return { status: "logged_in" };
      }

      return { status: "qr_pending" };
    } catch {
      return { status: "logged_out" };
    }
  }),

  /**
   * Request login (get QR code)
   */
  login: publicProcedure.mutation(async ({ ctx }) => {
    try {
      // Take a screenshot and extract QR code
      const screenshotBase64 = await captureScreenshot({ session: ctx.session });
      const qrData = await decodeQrFromBase64(screenshotBase64);

      if (qrData) {
        // Convert QR data to data URL for display
        const dataUrl = await toDataURL(qrData);

        return {
          success: false,
          state: { status: "qr_pending" as const, qrDataUrl: dataUrl },
        };
      }

      // Check if already logged in
      const probe = await runA11yProbe({ session: ctx.session });
      if (probe.loggedIn) {
        return {
          success: true,
          state: { status: "logged_in" as const },
        };
      }

      return {
        success: false,
        state: { status: "qr_pending" as const },
      };
    } catch {
      return {
        success: false,
        state: { status: "logged_out" as const },
      };
    }
  }),

  /**
   * Logout
   */
  logout: publicProcedure.mutation(async () => {
    // This would need to interact with WeChat UI to logout
    // For now, just return success
    return { success: true };
  }),

  /**
   * Subscribe to login flow - uses LLM agent to navigate login states
   * Handles QR codes, account confirmation, phone confirmation, and errors
   */
  loginSubscription: publicProcedure
    .input(
      z.object({
        timeoutMs: z.number().default(300_000), // 5 min default
        newAccount: z.boolean().default(false), // If true, click "Switch Account" instead of existing
      })
    )
    .subscription(({ input, ctx }) => {
      return observable<LoginSubscriptionEvent>((emit) => {
        const session = ctx.session;

        // No session available
        if (!session) {
          emit.next({ type: "error", message: "No session specified" });
          emit.complete();
          return () => {};
        }

        // AbortController combines: WS disconnect + timeout
        const abortController = new AbortController();
        const { signal: abortSignal } = abortController;

        // Timeout triggers abort
        const timeoutId = setTimeout(() => {
          abortController.abort();
        }, input.timeoutMs);

        const run = async () => {
          try {
            // Quick check: already logged in (WeChat app window)?
            const probe = await runA11yProbe({ session });
            if (probe.loggedIn) {
              emit.next({ type: "login_success" });
              emit.complete();
              return;
            }

            // Build context for agent
            const context: AgentContext = {
              session,
              emit: (event) => {
                if (!abortSignal.aborted) {
                  emit.next(event);
                }
              },
              abortSignal,
              loginOptions: {
                newAccount: input.newAccount,
              },
            };

            // Run LLM agent for all other cases
            emit.next({ type: "status", message: "Navigating login flow..." });
            const result = await runLoginAgent(context);

            if (abortSignal.aborted) {
              emit.next({ type: "login_timeout" });
            } else if (result.success) {
              emit.next({ type: "login_success" });
            } else {
              emit.next({ type: "error", message: result.error || "Login failed" });
            }
            emit.complete();
          } catch (error) {
            if (!abortSignal.aborted) {
              emit.next({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
              emit.complete();
            }
          }
        };

        run();

        // Cleanup: WS disconnect triggers abort
        return () => {
          clearTimeout(timeoutId);
          abortController.abort();
        };
      });
    }),
});
