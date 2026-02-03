import type { Action, A11yNode, Execution } from "../ia/types.js";
import { querySelector } from "../ia/selectors.js";
import { execCommand } from "../lib/exec.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ActionContext<TParams = unknown> {
  a11y: A11yNode;
  screenshot: string; // base64
  execution: Execution<TParams>;
  frame?: A11yNode; // Scoped frame for querySelector (from identify metadata)
}

/**
 * Execute an action.
 *
 * Actions are predefined operations like click, type, scroll, etc.
 * The selector in actions uses CSS-like syntax.
 */
export async function executeAction<TParams>(
  action: Action,
  ctx: ActionContext<TParams>
): Promise<void> {
  const { a11y, execution, frame } = ctx;
  const session = execution.context.session;
  // Use frame for scoped queries when available, fallback to full a11y tree
  const queryRoot = frame ?? a11y;

  switch (action.type) {
    case "click": {
      // Find element using CSS-like selector (scoped to frame if available)
      const element = querySelector(queryRoot, action.selector);
      if (!element?.bounds) {
        throw new Error(`Element not found: ${action.selector}`);
      }
      // Calculate center of element
      const x = Math.round(element.bounds.x + element.bounds.width / 2);
      const y = Math.round(element.bounds.y + element.bounds.height / 2);
      await execCommand("wechat-click", [String(x), String(y)], { session });
      break;
    }

    case "type": {
      // If selector provided, click first
      if (action.selector) {
        await executeAction({ type: "click", selector: action.selector }, ctx);
        await sleep(100);
      }
      // Type text using clipboard (Unicode-safe)
      await execCommand("wechat-type", [action.text], { session });
      break;
    }

    case "key": {
      // Press key combo (e.g., "Return", "Escape", "ctrl+a")
      await execCommand("wechat-key", [action.combo], { session });
      break;
    }

    case "scroll": {
      // Scroll in direction at optional coordinates
      const args = [action.direction, String(action.amount ?? 3)];
      if (action.x !== undefined && action.y !== undefined) {
        args.push(String(action.x), String(action.y));
      }
      await execCommand("wechat-scroll", args, { session });
      break;
    }

    case "wait": {
      await sleep(action.ms);
      break;
    }

    case "emit": {
      execution.emit(action.event);
      break;
    }

    case "sequence": {
      for (const subAction of action.actions) {
        await executeAction(subAction, ctx);
      }
      break;
    }
  }
}
