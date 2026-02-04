import type {
  Action,
  ActionParams,
  A11yNode,
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
async function executeEffect<TParams, TPlanState>(
  effect: Effect,
  execution: Execution<TParams, TPlanState>
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
export function createExecution<TParams extends ActionParams, TPlanState = unknown>(
  plan: Plan<TParams, TPlanState>,
  params: TParams,
  context: Context,
  options: {
    emit: (event: SubscriptionEvent) => void;
    abortSignal: AbortSignal;
  }
): Execution<TParams, TPlanState> {
  return {
    id: crypto.randomUUID(),
    plan,
    params,
    context,
    status: "running",
    stepCount: 0,
    abortSignal: options.abortSignal,
    emit: options.emit,
    planState: plan.initialPlanState?.() ?? ({} as TPlanState),
  };
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
export async function runExecution<TParams extends ActionParams, TPlanState = unknown>(
  execution: Execution<TParams, TPlanState>
): Promise<ExecutionResult> {
  const executionTimeoutMs = 300000; // 5 minutes total execution timeout
  const unknownStateTimeoutMs = 60000; // 1 minute for unknown states
  const executionStartTime = Date.now();
  let unknownStateSince: number | null = null;

  for (let step = 0; ; step++) {
    execution.stepCount = step;

    // Check execution timeout
    const elapsedTotalMs = Date.now() - executionStartTime;
    if (elapsedTotalMs > executionTimeoutMs) {
      execution.status = "failed";
      execution.error = `Execution timeout after ${Math.round(elapsedTotalMs / 1000)}s`;
      return { success: false, error: execution.error };
    }

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

    console.log(`[FSM] Identified: mainWindow=${identified.mainWindow.state.id}, popup=${identified.popup?.state.id ?? "none"}, contactCard=${identified.contactCard?.state.id ?? "none"}`);

    // 3. Reduce: Update app state via reducers (pass metadata from identify)
    const screenshotBuffer = Buffer.from(screenshot, "base64");
    let newAppState = identified.mainWindow.state.reduce({
      prev: execution.context.state,
      action: execution.lastAction ?? null,
      a11y,
      screenshot: screenshotBuffer,
      db: execution.context.db,
      metadata: identified.mainWindow.metadata,
    });

    // Run popup reducer if popup is present, otherwise clear popup
    if (identified.popup) {
      newAppState = identified.popup.state.reduce({
        prev: newAppState,
        action: execution.lastAction ?? null,
        a11y,
        screenshot: screenshotBuffer,
        db: execution.context.db,
        metadata: identified.popup.metadata,
      });
    } else {
      newAppState = { ...newAppState, popup: null };
    }

    // Run contactCard reducer if present, otherwise clear contactCard
    if (identified.contactCard) {
      newAppState = identified.contactCard.state.reduce({
        prev: newAppState,
        action: execution.lastAction ?? null,
        a11y,
        screenshot: screenshotBuffer,
        db: execution.context.db,
        metadata: identified.contactCard.metadata,
      });
    } else {
      newAppState = { ...newAppState, contactCard: null };
    }

    const prevAppState = execution.context.state;
    execution.context.state = newAppState;

    // 4. Run effects (reactive, 0..n based on state diff)
    const effects = collectEffects(prevAppState, newAppState, execution.context.db);
    for (const effect of effects) {
      await executeEffect(effect, execution);
    }

    // 5. Persist: Save context to DB
    await execution.context.save();

    // 6. Select action: Plan returns SelectedAction with action + metadata
    const selected = execution.plan.selectAction({
      state: newAppState,
      params: execution.params,
      db: execution.context.db,
      sessionId: execution.context.sessionId,
      a11y,
      identified,
      planState: execution.planState,
    });

    console.log(`[FSM] Selected action: ${selected?.action?.type ?? "none"}`);

    // 7. No action = stuck (goal not reached and nothing to do)
    if (!selected) {
      execution.status = "failed";
      execution.error = "No action selected";
      return { success: false, error: execution.error };
    }

    // 8. Extract frame from the metadata returned by selectAction
    // No more heuristics - just use what selectAction returned
    const actionFrame = (selected.metadata as { frame?: A11yNode } | undefined)?.frame;

    // 9. Execute action
    const actionContext: ActionContext<TParams, TPlanState> = {
      a11y,
      screenshot,
      execution,
      frame: actionFrame,
    };

    try {
      await executeAction(selected.action, actionContext);
      execution.lastAction = selected.action;
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
        sessionId: execution.context.sessionId,
        planState: execution.planState,
      })
    ) {
      execution.status = "succeeded";
      return { success: true };
    }

    // 11. Wait for UI to settle
    await sleep(10);
  }
}
