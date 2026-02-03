import type { A11yNode } from "./types.js";

// ============================================
// Ancestor Traversal
// ============================================

/**
 * Find an ancestor node matching a predicate.
 *
 * @param node - The starting node
 * @param predicate - Either a role name string or a predicate function
 * @returns The matching ancestor or null
 *
 * @example
 * // Find the containing frame
 * findAncestor(button, 'frame')
 *
 * @example
 * // Find ancestor with specific name
 * findAncestor(button, (n) => n.role === 'frame' && n.name === 'WeChat')
 */
export function findAncestor(
  node: A11yNode,
  predicate: string | ((n: A11yNode) => boolean)
): A11yNode | null {
  const pred =
    typeof predicate === "string"
      ? (n: A11yNode) => n.role === predicate
      : predicate;

  let current = node.parent;
  while (current) {
    if (pred(current)) return current;
    current = current.parent;
  }
  return null;
}

// ============================================
// Selector AST Types
// ============================================

interface SelectorNode {
  role: string; // e.g., "push-button", "*" for any
  attrs: AttrMatcher[];
  pseudo?: { type: "nth-child"; index: number }; // 1-indexed like CSS
}

interface AttrMatcher {
  name: string; // "name", "role", etc.
  op: "=" | "*=" | "^=" | "$="; // exact, contains, starts, ends
  value: string | RegExp;
}

interface SelectorAST {
  nodes: SelectorNode[];
  combinators: ("descendant" | "child")[]; // ' ' or '>'
}

// ============================================
// Tokenizer
// ============================================

function tokenize(selector: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let inRegex = false;
  let quoteChar = "";

  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];

    if (inQuotes) {
      current += char;
      if (char === quoteChar && selector[i - 1] !== "\\") {
        inQuotes = false;
      }
    } else if (inRegex) {
      current += char;
      if (char === "/" && selector[i - 1] !== "\\") {
        // Check for flags after closing /
        while (i + 1 < selector.length && /[gimsuy]/.test(selector[i + 1])) {
          current += selector[++i];
        }
        inRegex = false;
      }
    } else if (char === '"' || char === "'") {
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (char === "/" && selector[i - 1] === "=") {
      inRegex = true;
      current += char;
    } else if (char === " " || char === ">") {
      if (current.trim()) tokens.push(current.trim());
      if (char === ">") tokens.push(">");
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) tokens.push(current.trim());

  return tokens;
}

// ============================================
// Parser
// ============================================

function parseNode(token: string): SelectorNode {
  // Parse: role[attr="value"]:pseudo
  const roleMatch = token.match(/^([a-z-]+|\*)/);
  const role = roleMatch ? roleMatch[1] : "*";

  const attrs: AttrMatcher[] = [];

  // Match attributes: [name="value"], [name=/regex/flags], [name*="value"]
  const attrRegex =
    /\[([a-z]+)(=|\*=|\^=|\$=)("([^"]+)"|'([^']+)'|\/(.+?)\/([gimsuy]*))\]/g;
  let match;
  while ((match = attrRegex.exec(token)) !== null) {
    const name = match[1];
    const op = match[2] as "=" | "*=" | "^=" | "$=";
    let value: string | RegExp;

    if (match[6]) {
      // Regex value
      value = new RegExp(match[6], match[7]);
    } else {
      // String value
      value = match[4] || match[5] || "";
    }

    attrs.push({ name, op, value });
  }

  // Parse :nth-child(n)
  let pseudo: SelectorNode["pseudo"];
  const pseudoMatch = token.match(/:nth-child\((\d+)\)/);
  if (pseudoMatch) {
    pseudo = { type: "nth-child", index: parseInt(pseudoMatch[1]) };
  }

  return { role, attrs, pseudo };
}

function buildAST(tokens: string[]): SelectorAST {
  const nodes: SelectorNode[] = [];
  const combinators: ("descendant" | "child")[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token === ">") {
      combinators.push("child");
      i++;
      continue;
    }

    // If previous was a node and this isn't '>', it's a descendant
    if (nodes.length > combinators.length) {
      combinators.push("descendant");
    }

    nodes.push(parseNode(token));
    i++;
  }

  return { nodes, combinators };
}

/**
 * Parse a CSS-like selector string into an AST.
 */
export function parseSelector(selector: string): SelectorAST {
  const tokens = tokenize(selector);
  return buildAST(tokens);
}

// ============================================
// Matcher
// ============================================

function matchesNode(
  node: A11yNode,
  target: SelectorNode,
  siblingIndex?: number
): boolean {
  // Check role
  if (target.role !== "*" && node.role !== target.role) {
    return false;
  }

  // Check attributes
  for (const attr of target.attrs) {
    const nodeValue = (node[attr.name as keyof A11yNode] as string) ?? "";

    if (attr.value instanceof RegExp) {
      if (!attr.value.test(nodeValue)) return false;
    } else {
      switch (attr.op) {
        case "=":
          if (nodeValue !== attr.value) return false;
          break;
        case "*=":
          if (!nodeValue.includes(attr.value)) return false;
          break;
        case "^=":
          if (!nodeValue.startsWith(attr.value)) return false;
          break;
        case "$=":
          if (!nodeValue.endsWith(attr.value)) return false;
          break;
      }
    }
  }

  // Check :nth-child (1-indexed)
  if (target.pseudo?.type === "nth-child") {
    if (siblingIndex === undefined || siblingIndex + 1 !== target.pseudo.index) {
      return false;
    }
  }

  return true;
}

function walkTree(
  node: A11yNode,
  fn: (n: A11yNode, index?: number) => boolean
): A11yNode | null {
  if (fn(node)) return node;
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const result = walkTree(children[i], fn);
    if (result) return result;
  }
  return null;
}

function walkChildren(
  node: A11yNode,
  fn: (n: A11yNode, index: number) => boolean
): A11yNode | null {
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    if (fn(children[i], i)) return children[i];
  }
  return null;
}

function matchAST(
  node: A11yNode,
  ast: SelectorAST,
  nodeIndex: number
): A11yNode | null {
  if (nodeIndex >= ast.nodes.length) return null;

  const target = ast.nodes[nodeIndex];
  const isLast = nodeIndex === ast.nodes.length - 1;
  const combinator =
    nodeIndex > 0 ? ast.combinators[nodeIndex - 1] : "descendant";

  // For first node or descendant, search entire subtree
  // For child combinator, only search direct children
  const searchFn =
    nodeIndex === 0 || combinator === "descendant" ? walkTree : walkChildren;

  return searchFn(node, (candidate, siblingIndex) => {
    if (!matchesNode(candidate, target, siblingIndex)) return false;

    if (isLast) return true;

    // Continue matching rest of selector from this candidate
    const nextMatch = matchAST(candidate, ast, nodeIndex + 1);
    return nextMatch !== null;
  });
}

function matchASTForResult(
  node: A11yNode,
  ast: SelectorAST,
  nodeIndex: number
): A11yNode | null {
  if (nodeIndex >= ast.nodes.length) return null;

  const target = ast.nodes[nodeIndex];
  const isLast = nodeIndex === ast.nodes.length - 1;
  const combinator =
    nodeIndex > 0 ? ast.combinators[nodeIndex - 1] : "descendant";

  const searchFn =
    nodeIndex === 0 || combinator === "descendant" ? walkTree : walkChildren;

  let result: A11yNode | null = null;

  searchFn(node, (candidate, siblingIndex) => {
    if (!matchesNode(candidate, target, siblingIndex)) return false;

    if (isLast) {
      result = candidate;
      return true;
    }

    // Continue matching rest of selector from this candidate
    const nextMatch = matchASTForResult(candidate, ast, nodeIndex + 1);
    if (nextMatch) {
      result = nextMatch;
      return true;
    }
    return false;
  });

  return result;
}

/**
 * Find the first element matching a CSS-like selector.
 *
 * @param root - Root of the a11y tree
 * @param selector - CSS-like selector string
 * @returns The matching node or null
 *
 * @example
 * // Find a button by name
 * querySelector(tree, 'push-button[name="OK"]')
 *
 * @example
 * // Find a button within a frame
 * querySelector(tree, 'frame[name="WeChat"] push-button[name="OK"]')
 *
 * @example
 * // Find the second list item (1-indexed)
 * querySelector(tree, 'list[name="Chats"] > list-item:nth-child(2)')
 *
 * @example
 * // Use regex for name matching
 * querySelector(tree, 'push-button[name=/OK|Confirm/i]')
 */
export function querySelector(
  root: A11yNode,
  selector: string
): A11yNode | null {
  const ast = parseSelector(selector);
  return matchASTForResult(root, ast, 0);
}

/**
 * Find all elements matching a CSS-like selector.
 *
 * @param root - Root of the a11y tree
 * @param selector - CSS-like selector string
 * @returns Array of matching nodes
 */
export function querySelectorAll(root: A11yNode, selector: string): A11yNode[] {
  const ast = parseSelector(selector);
  const results: A11yNode[] = [];

  function collectFromNode(node: A11yNode, startIndex: number): void {
    const target = ast.nodes[startIndex];
    const isLast = startIndex === ast.nodes.length - 1;
    const combinator =
      startIndex > 0 ? ast.combinators[startIndex - 1] : "descendant";

    const children = node.children ?? [];

    // For descendant, we check the node itself first
    if (startIndex === 0 || combinator === "descendant") {
      if (matchesNode(node, target)) {
        if (isLast) {
          results.push(node);
        } else {
          // Continue matching from children
          for (let i = 0; i < children.length; i++) {
            collectFromNode(children[i], startIndex + 1);
          }
        }
      }
      // Also recurse into children for descendant combinator
      for (let i = 0; i < children.length; i++) {
        collectFromNode(children[i], startIndex);
      }
    } else {
      // Child combinator: only check direct children
      for (let i = 0; i < children.length; i++) {
        if (matchesNode(children[i], target, i)) {
          if (isLast) {
            results.push(children[i]);
          } else {
            collectFromNode(children[i], startIndex + 1);
          }
        }
      }
    }
  }

  collectFromNode(root, 0);
  return results;
}
