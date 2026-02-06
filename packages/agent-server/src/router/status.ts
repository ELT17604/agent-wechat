import { z } from "zod";
import { observable } from "@trpc/server/observable";
import { router, publicProcedure } from "./trpc.js";
import { runA11yProbe } from "../lib/a11y.js";
import { captureScreenshot } from "../lib/screenshot.js";
import { decodeQrFromBase64, toDataURL } from "../lib/qr.js";
import { getDb } from "../db/index.js";
import { createContext } from "../context/index.js";
import { createExecution, runExecution } from "../execution/index.js";
import { loginPlan, authStatusPlan } from "../plans/index.js";
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
   * Check auth status via FSM observation
   * Runs one FSM cycle to update state and returns isLoggedIn
   */
  authStatus: publicProcedure.query(async ({ ctx }): Promise<{ isLoggedIn: boolean }> => {
    const session = ctx.session;
    if (!session) {
      return { isLoggedIn: false };
    }

    const db = getDb();
    const context = await createContext(session, db);
    const abortController = new AbortController();

    const execution = createExecution(
      authStatusPlan,
      {},
      context,
      {
        emit: () => {},
        abortSignal: abortController.signal,
      }
    );

    await runExecution(execution);

    return { isLoggedIn: context.state.mainWindow.isLoggedIn };
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
   * Subscribe to login flow - uses FSM to navigate login states
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
            // Get drizzle db for FSM context
            const db = getDb();

            // Create FSM context
            const context = await createContext(session, db);

            // Create execution
            const execution = createExecution(
              loginPlan,
              { newAccount: input.newAccount },
              context,
              {
                emit: (event) => {
                  if (!abortSignal.aborted) {
                    emit.next(event as LoginSubscriptionEvent);
                  }
                },
                abortSignal,
              }
            );

            // Run FSM execution - plan handles all phases including
            // user detection and key extraction after login
            emit.next({ type: "status", message: "Navigating login flow..." });
            const result = await runExecution(execution);

            if (execution.status === "aborted") {
              emit.next({ type: "login_timeout" });
            } else if (!result.success) {
              emit.next({ type: "error", message: result.error || "Login failed" });
            }
            // login_success is emitted by the plan itself (after key extraction)
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
