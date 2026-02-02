import type {
  ActionParams,
  A11yNode,
  AppState,
  Context,
  Effect,
  Execution,
  ExecutionStatus,
  InformationArchitecture,
  Plan,
  SubscriptionEvent,
} from "../ia/types.js";
import { identifyStates } from "../ia/index.js";
import { getA11yDesktop } from "../lib/a11y.js";
import { captureScreenshot } from "../lib/screenshot.js";
import { toDataURL } from "../lib/qr.js";
import { collectEffects } from "../effects/watchers.js";
import { executeAction, type ActionContext } from "./actions.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an effect.
 */
async function executeEffect<TParams>(
  effect: Effect,
  execution: Execution<TParams>
): Promise<void> {
  switch (effect.type) {
    case "emit": {
      const event = effect.event;
      // Special handling for QR events - add data URL for client display
      if (event.type === "qr" && event.qrData && !event.qrDataUrl) {
        try {
          const qrDataUrl = await toDataURL(event.qrData as string);
          execution.emit({ ...event, qrDataUrl });
        } catch {
          // If conversion fails, emit without data URL
          execution.emit(event);
        }
      } else {
        execution.emit(event);
      }
      break;
    }
    case "dbWrite":
      // TODO: Implement db write if needed
      break;
  }
}

/**
 * Extract debug info from a11y tree for logging unknown states.
 */
function extractDebugInfo(node: A11yNode): { buttons: string[]; labels: string[]; frames: string[] } {
  const buttons: string[] = [];
  const labels: string[] = [];
  const frames: string[] = [];

  function walk(n: A11yNode) {
    if (n.role === "push-button" && n.name) {
      buttons.push(n.name);
    } else if (n.role === "label" && n.name) {
      labels.push(n.name);
    } else if (n.role === "frame" && n.name) {
      frames.push(n.name);
    }
    n.children?.forEach(walk);
  }

  walk(node);
  return { buttons: buttons.slice(0, 10), labels: labels.slice(0, 10), frames };
}

/**
 * Create an Execution instance.
 */
export function createExecution<TParams extends ActionParams>(
  plan: Plan<TParams>,
  params: TParams,
  context: Context,
  options: {
    emit: (event: SubscriptionEvent) => void;
    abortSignal: AbortSignal;
  }
): Execution<TParams> {
  return {
    id: crypto.randomUUID(),
    plan,
    params,
    context,
    status: "running",
    stepCount: 0,
    abortSignal: options.abortSignal,
    emit: options.emit,
  };
}

/**
 * Compute additional params needed by specific actions.
 *
 * For example, click_chat needs an index based on chatName.
 */
function computeActionParams(
  actionKey: string,
  state: AppState,
  params: ActionParams
): ActionParams {
  const result = { ...params };

  switch (actionKey) {
    case "click_search_result": {
      // Find index of matching result
      const results = state.mainWindow.searchResults ?? [];
      const targetIndex = results.findIndex((r) =>
        r.name.includes(params.chatName ?? "")
      );
      result.index = targetIndex >= 0 ? targetIndex : 0;
      break;
    }
    case "type_search": {
      // Use chatName as query
      result.query = params.chatName;
      break;
    }
  }

  return result;
}

export interface ExecutionResult {
  success: boolean;
  error?: string;
}

/**
 * Run an execution loop.
 *
 * This is the main FSM execution loop that:
 * 1. Observes the a11y tree
 * 2. Identifies the current state
 * 3. Runs the reducer to update AppState
 * 4. Checks if goal is reached
 * 5. Selects and executes an action
 * 6. Repeats
 */
export async function runExecution<TParams extends ActionParams>(
  execution: Execution<TParams>,
  ia: InformationArchitecture
): Promise<ExecutionResult> {
  const maxSteps = 50;

  for (let step = 0; step < maxSteps; step++) {
    execution.stepCount = step;

    // Check abort signal
    if (execution.abortSignal.aborted) {
      execution.status = "aborted";
      return { success: false, error: "Aborted" };
    }

    // 1. Observe: Get a11y tree and screenshot
    const { tree: a11y, error: a11yError } = await getA11yDesktop({
      session: execution.context.session,
    });

    if (!a11y || a11yError) {
      execution.status = "failed";
      execution.error = a11yError || "Failed to get a11y tree";
      return { success: false, error: execution.error };
    }

    const screenshot = await captureScreenshot({
      session: execution.context.session,
    });

    // 2. Identify: Find current states for BOTH FSMs
    const identified = identifyStates(a11y, screenshot);

    if (!identified.mainWindow) {
      // Unknown state - log debug info and wait
      const debugInfo = extractDebugInfo(a11y);
      console.log("[FSM] Unknown state. A11y summary:", JSON.stringify(debugInfo, null, 2));
      execution.emit({
        type: "status",
        message: `Unknown UI state, waiting... (found: ${debugInfo.buttons.join(", ") || "no buttons"})`,
      });
      await sleep(1000);
      continue;
    }

    console.log(`[FSM] Identified: mainWindow=${identified.mainWindow.id}, popup=${identified.popup?.id ?? "none"}`);

    // 3. Reduce: Update app state via reducers
    let newAppState = identified.mainWindow.reduce({
      prev: execution.context.state,
      action: execution.lastAction ?? null,
      a11y,
      screenshot: Buffer.from(screenshot, "base64"),
      db: execution.context.db,
    });

    // Run popup reducer if popup is present, otherwise clear popup
    if (identified.popup) {
      newAppState = identified.popup.reduce({
        prev: newAppState,
        action: execution.lastAction ?? null,
        a11y,
        screenshot: Buffer.from(screenshot, "base64"),
        db: execution.context.db,
      });
    } else {
      newAppState = { ...newAppState, popup: null };
    }

    const prevAppState = execution.context.state;
    execution.context.state = newAppState;

    // 4. Run effects (reactive, 0..n based on state diff)
    const effects = collectEffects(prevAppState, newAppState);
    for (const effect of effects) {
      await executeEffect(effect, execution);
    }

    // 5. Persist: Save context to DB
    await execution.context.save();

    // 6. Check: Is goal reached?
    if (
      execution.plan.isGoalReached({
        state: newAppState,
        params: execution.params,
        db: execution.context.db,
      })
    ) {
      execution.status = "succeeded";
      return { success: true };
    }

    // 7. Select action: Plan returns action key
    const actionKey = execution.plan.selectAction({
      state: newAppState,
      params: execution.params,
      db: execution.context.db,
    });

    console.log(`[FSM] Selected action: ${actionKey ?? "none"}`);

    if (!actionKey) {
      // Re-check goal (might be done)
      if (
        execution.plan.isGoalReached({
          state: newAppState,
          params: execution.params,
          db: execution.context.db,
        })
      ) {
        execution.status = "succeeded";
        return { success: true };
      }

      execution.status = "failed";
      execution.error = "No action selected";
      return { success: false, error: "No action selected" };
    }

    // 8. Create action: Call lambda with params
    const actionCreator = ia.actions[actionKey];
    if (!actionCreator) {
      execution.status = "failed";
      execution.error = `Unknown action: ${actionKey}`;
      return { success: false, error: `Unknown action: ${actionKey}` };
    }

    // Compute additional params if needed
    const actionParams = computeActionParams(
      actionKey,
      newAppState,
      execution.params
    );
    const action = actionCreator(actionParams);

    // 9. Execute action
    const actionContext: ActionContext<TParams> = {
      a11y,
      screenshot,
      execution,
    };

    try {
      await executeAction(action, actionContext);
      execution.lastAction = action;
    } catch (error) {
      execution.emit({
        type: "status",
        message: `Action failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      // Continue - action failure doesn't stop execution
    }

    // 10. Wait for UI to settle
    await sleep(200);
  }

  execution.status = "failed";
  execution.error = "Max steps exceeded";
  return { success: false, error: "Max steps exceeded" };
}
