import type {
  Action,
  ActionParams,
  ActionTemplate,
  A11yNode,
  AppState,
  Context,
  Effect,
  Execution,
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
  }
}

/**
 * Extract debug info from a11y tree for logging unknown states.
 */
function extractDebugInfo(node: A11yNode): {
  buttons: string[];
  labels: string[];
  frames: string[];
  lists: string[];
  texts: string[];
  topRoles: { role: string; count: number }[];
  sampleNodes: { depth: number; role: string; name: string; bounds?: A11yNode["bounds"] }[];
  totalNodes: number;
} {
  const buttons: string[] = [];
  const labels: string[] = [];
  const frames: string[] = [];
  const lists: string[] = [];
  const texts: string[] = [];
  const roleCounts: Record<string, number> = {};
  const sampleNodes: { depth: number; role: string; name: string; bounds?: A11yNode["bounds"] }[] = [];
  let totalNodes = 0;

  function walk(n: A11yNode, depth: number) {
    totalNodes += 1;
    roleCounts[n.role] = (roleCounts[n.role] ?? 0) + 1;

    if (sampleNodes.length < 30) {
      sampleNodes.push({
        depth,
        role: n.role,
        name: n.name,
        bounds: n.bounds,
      });
    }

    if (n.role === "push-button" && n.name) {
      buttons.push(n.name);
    } else if (n.role === "label" && n.name) {
      labels.push(n.name);
    } else if (n.role === "frame" && n.name) {
      frames.push(n.name);
    } else if (n.role === "list" && n.name) {
      lists.push(n.name);
    } else if (n.role === "text" && n.name) {
      texts.push(n.name);
    }

    n.children?.forEach((child) => walk(child, depth + 1));
  }

  walk(node, 0);

  const topRoles = Object.entries(roleCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([role, count]) => ({ role, count }));

  return {
    buttons: buttons.slice(0, 10),
    labels: labels.slice(0, 10),
    frames: frames.slice(0, 10),
    lists: lists.slice(0, 10),
    texts: texts.slice(0, 10),
    topRoles,
    sampleNodes,
    totalNodes,
  };
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
  execution: Execution<TParams>
): Promise<ExecutionResult> {
  const maxSteps = 50;
  const unknownStateTimeoutMs = 60000; // 1 minute
  let unknownStateSince: number | null = null;

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
      // Track when we first entered unknown state
      if (unknownStateSince === null) {
        unknownStateSince = Date.now();
      }

      const elapsedMs = Date.now() - unknownStateSince;
      const elapsedSec = Math.round(elapsedMs / 1000);

      // Fail after timeout
      if (elapsedMs > unknownStateTimeoutMs) {
        const debugInfo = extractDebugInfo(a11y);
        console.log("[FSM] Unknown state timeout. A11y summary:", JSON.stringify(debugInfo, null, 2));
        execution.status = "failed";
        execution.error = `Unknown state for ${elapsedSec}s - no matching IAState found`;
        return { success: false, error: execution.error };
      }

      // Log and wait
      const debugInfo = extractDebugInfo(a11y);
      console.log(`[FSM] Unknown state (${elapsedSec}s). Buttons: ${debugInfo.buttons.join(", ") || "none"}`);
      execution.emit({
        type: "status",
        message: `Unknown UI state (${elapsedSec}s), waiting... (buttons: ${debugInfo.buttons.join(", ") || "none"})`,
      });
      await sleep(1000);
      continue;
    }

    // Reset unknown state timer when we identify a state
    unknownStateSince = null;

    console.log(`[FSM] Identified: mainWindow=${identified.mainWindow.id}, popup=${identified.popup?.id ?? "none"}`);

    // 3. Reduce: Update app state via reducers (pass metadata from identify)
    const screenshotBuffer = Buffer.from(screenshot, "base64");
    let newAppState = identified.mainWindow.reduce({
      prev: execution.context.state,
      action: execution.lastAction ?? null,
      a11y,
      screenshot: screenshotBuffer,
      db: execution.context.db,
      metadata: identified.mainWindowMetadata,
    });

    // Run popup reducer if popup is present, otherwise clear popup
    if (identified.popup) {
      newAppState = identified.popup.reduce({
        prev: newAppState,
        action: execution.lastAction ?? null,
        a11y,
        screenshot: screenshotBuffer,
        db: execution.context.db,
        metadata: identified.popupMetadata,
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

    // 6. Select action: Plan returns action key
    const actionKey = execution.plan.selectAction({
      state: newAppState,
      params: execution.params,
      db: execution.context.db,
    });

    console.log(`[FSM] Selected action: ${actionKey ?? "none"}`);

    // 7. No action = stuck (goal not reached and nothing to do)
    if (!actionKey) {
      execution.status = "failed";
      execution.error = "No action selected";
      return { success: false, error: execution.error };
    }

    // 8. Look up command from the appropriate state
    // Popup actions come from popup state, others from mainWindow state
    const isPopupAction = actionKey.startsWith("dismiss_") || actionKey.startsWith("cancel_");
    const targetState = isPopupAction ? identified.popup : identified.mainWindow;
    const actionFrame = isPopupAction
      ? (identified.popupMetadata as { frame?: A11yNode } | undefined)?.frame
      : (identified.mainWindowMetadata as { frame?: A11yNode } | undefined)?.frame;

    const commandTemplate: ActionTemplate | undefined = targetState?.commands?.[actionKey];
    if (!commandTemplate) {
      execution.status = "failed";
      execution.error = `Unknown command: ${actionKey} (state: ${targetState?.id ?? "none"})`;
      return { success: false, error: execution.error };
    }

    // Compute additional params if needed
    const actionParams = computeActionParams(
      actionKey,
      newAppState,
      execution.params
    );

    // Command can be static Action or function that returns Action
    const action: Action = typeof commandTemplate === "function"
      ? commandTemplate(actionParams)
      : commandTemplate;

    // 9. Execute action
    const actionContext: ActionContext<TParams> = {
      a11y,
      screenshot,
      execution,
      frame: actionFrame,
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

    // 10. Check goal after action
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

    // 11. Wait for UI to settle
    await sleep(200);
  }

  execution.status = "failed";
  execution.error = "Max steps exceeded";
  return { success: false, error: "Max steps exceeded" };
}
