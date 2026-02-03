import { execCommand, type ExecOptions } from "./exec.js";

export interface A11yProbeResult {
  loggedIn: boolean;
  hasChats: boolean;
  hasMessages: boolean;
  error?: string;
}

export interface A11yChatItem {
  index: number;
  name: string;
  unread: number;
  sender: string | null;
  preview: string | null;
  time: string | null;
  pinned: boolean;
  muted: boolean;
  raw: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface A11yMessageItem {
  index: number;
  text: string;
  kind: "message" | "timestamp";
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface A11yButtonItem {
  name: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface A11yTreeItem {
  depth: number;
  role: string;
  name: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

type A11yScope = "chats" | "messages" | "buttons" | "full" | "desktop";

const A11Y_SCRIPT_PATH = "/opt/tools/wechat-a11y-dump";

/**
 * Run a11y probe to check login state
 */
export async function runA11yProbe(options?: ExecOptions): Promise<A11yProbeResult> {
  const result = await execCommand("python3", [A11Y_SCRIPT_PATH, "--probe", "--format", "json"], options);

  if (result.exitCode !== 0) {
    return {
      loggedIn: false,
      hasChats: false,
      hasMessages: false,
      error: result.stderr || result.stdout,
    };
  }

  try {
    return JSON.parse(result.stdout) as A11yProbeResult;
  } catch {
    return {
      loggedIn: false,
      hasChats: false,
      hasMessages: false,
      error: "Failed to parse a11y probe output",
    };
  }
}

/**
 * Get accessibility data for a specific scope
 */
export async function getA11yData(scope: A11yScope, options?: ExecOptions): Promise<{
  items: unknown[];
  error?: string;
}> {
  // Validate scope to prevent injection
  const validScopes: A11yScope[] = ["chats", "messages", "buttons", "full", "desktop"];
  if (!validScopes.includes(scope)) {
    return { items: [], error: `Invalid scope: ${scope}` };
  }

  const result = await execCommand("python3", [
    A11Y_SCRIPT_PATH,
    "--scope",
    scope,
    "--format",
    "json",
  ], options);

  if (result.exitCode !== 0) {
    return { items: [], error: result.stderr || result.stdout };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return { items: parsed.items || [], error: parsed.error };
  } catch {
    return { items: [], error: "Failed to parse a11y output" };
  }
}

/**
 * Get chat list from accessibility tree
 */
export async function getA11yChats(options?: ExecOptions): Promise<{
  items: A11yChatItem[];
  error?: string;
}> {
  const result = await getA11yData("chats", options);
  return result as { items: A11yChatItem[]; error?: string };
}

/**
 * Get messages from accessibility tree
 */
export async function getA11yMessages(options?: ExecOptions): Promise<{
  items: A11yMessageItem[];
  error?: string;
}> {
  const result = await getA11yData("messages", options);
  return result as { items: A11yMessageItem[]; error?: string };
}

/**
 * Get buttons from accessibility tree
 */
export async function getA11yButtons(options?: ExecOptions): Promise<{
  items: A11yButtonItem[];
  error?: string;
}> {
  const result = await getA11yData("buttons", options);
  return result as { items: A11yButtonItem[]; error?: string };
}

/**
 * Get full accessibility tree
 */
export async function getA11yTree(options?: ExecOptions): Promise<{
  items: A11yTreeItem[];
  error?: string;
}> {
  const result = await getA11yData("full", options);
  return result as { items: A11yTreeItem[]; error?: string };
}

/**
 * Get accessibility tree in ARIA format (nested, human-readable)
 *
 * Example output:
 * - desktop-frame "main" @(0,0 1280x800)
 *   - application "wechat"
 *     - frame "WeChat" @(100,100 400x600)
 *       - button "OK" @(150,500 80x30)
 */
export async function getA11yAria(options?: ExecOptions): Promise<{
  tree: string;
  error?: string;
}> {
  const result = await execCommand("python3", [
    A11Y_SCRIPT_PATH,
    "--format",
    "aria",
  ], options);

  if (result.exitCode !== 0) {
    return { tree: "", error: result.stderr || result.stdout };
  }

  return { tree: result.stdout, error: undefined };
}

/**
 * Nested A11y node for CSS-like selector matching
 */
export interface A11yNode {
  role: string;
  name: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  children?: A11yNode[];
  parent?: A11yNode;
}

/**
 * Add parent references to all nodes in the tree.
 * This enables traversal up the tree via findAncestor.
 */
function addParentRefs(node: A11yNode, parent?: A11yNode): void {
  node.parent = parent;
  node.children?.forEach((child) => addParentRefs(child, node));
}

/**
 * Get the desktop accessibility tree as a nested structure.
 * Compatible with CSS-like selectors (querySelector).
 */
export async function getA11yDesktop(options?: ExecOptions): Promise<{
  tree: A11yNode | null;
  error?: string;
}> {
  const result = await execCommand("python3", [
    A11Y_SCRIPT_PATH,
    "--format",
    "json",
  ], options);

  if (result.exitCode !== 0) {
    return { tree: null, error: result.stderr || result.stdout };
  }

  try {
    const parsed = JSON.parse(result.stdout) as A11yNode;
    addParentRefs(parsed);
    return { tree: parsed, error: undefined };
  } catch {
    return { tree: null, error: "Failed to parse a11y output" };
  }
}
