import { router, publicProcedure } from "./trpc.js";
import {
  createSessionParamsSchema,
  sessionIdParamsSchema,
} from "@thisnick/agent-wechat-shared";
import {
  createSession,
  getSession,
  listSessions,
  startSession,
  stopSession,
  deleteSession,
} from "../sessions/manager.js";

export const sessionsRouter = router({
  /**
   * Create a new session
   */
  create: publicProcedure
    .input(createSessionParamsSchema)
    .mutation(async ({ input }) => {
      return await createSession(input.name);
    }),

  /**
   * List all sessions
   */
  list: publicProcedure.query(async () => {
    return listSessions();
  }),

  /**
   * Get a session by ID or name
   */
  get: publicProcedure
    .input(sessionIdParamsSchema)
    .query(async ({ input }) => {
      return getSession(input.id);
    }),

  /**
   * Start a session
   */
  start: publicProcedure
    .input(sessionIdParamsSchema)
    .mutation(async ({ input }) => {
      return await startSession(input.id);
    }),

  /**
   * Stop a session
   */
  stop: publicProcedure
    .input(sessionIdParamsSchema)
    .mutation(async ({ input }) => {
      return await stopSession(input.id);
    }),

  /**
   * Delete a session
   */
  delete: publicProcedure
    .input(sessionIdParamsSchema)
    .mutation(async ({ input }) => {
      await deleteSession(input.id);
      return { success: true };
    }),
});
