import { z } from "zod";
import type { Plan, ActionParams, SelectedAction } from "../ia/types.js";

/**
 * Auth status plan params
 */
export interface AuthStatusParams extends ActionParams {}

const authStatusParamsSchema = z.object({}) as unknown as z.ZodSchema<AuthStatusParams>;

/**
 * Auth Status Plan - Single observation to update state
 *
 * This plan completes immediately after one observation.
 * The reducer updates `isLoggedIn` based on the identified state.
 */
export const authStatusPlan: Plan<AuthStatusParams> = {
  id: "auth_status",
  description: "Check auth status via single observation",
  params: authStatusParamsSchema,

  // Goal reached immediately - we just want one observation
  isGoalReached: () => true,

  // No actions needed - just observe
  selectAction: async (): Promise<SelectedAction | null> => null,
};
