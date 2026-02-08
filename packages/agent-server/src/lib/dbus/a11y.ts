import dbus from "dbus-next";
import type { A11yNode } from "../a11y.js";
import { getSessionBus } from "./index.js";

const ATSPI_BUS_NAME = "org.a11y.Bus";
const ATSPI_BUS_PATH = "/org/a11y/bus";
const ATSPI_BUS_IFACE = "org.a11y.Bus";

const ATSPI_REGISTRY_NAME = "org.a11y.atspi.Registry";
const ATSPI_REGISTRY_PATH = "/org/a11y/atspi/accessible/root";
const ATSPI_ACCESSIBLE_IFACE = "org.a11y.atspi.Accessible";
const ATSPI_COMPONENT_IFACE = "org.a11y.atspi.Component";
const DBUS_PROPERTIES_IFACE = "org.freedesktop.DBus.Properties";

// AT-SPI role names mapping (subset of common roles)
const ROLE_NAMES: Record<number, string> = {
  0: "invalid",
  1: "accelerator-label",
  2: "alert",
  3: "animation",
  4: "arrow",
  5: "calendar",
  6: "canvas",
  7: "check-box",
  8: "check-menu-item",
  9: "color-chooser",
  10: "column-header",
  11: "combo-box",
  12: "date-editor",
  13: "desktop-icon",
  14: "desktop-frame",
  15: "dial",
  16: "dialog",
  17: "directory-pane",
  18: "drawing-area",
  19: "file-chooser",
  20: "filler",
  21: "focus-traversable",
  22: "font-chooser",
  23: "frame",
  24: "glass-pane",
  25: "html-container",
  26: "icon",
  27: "image",
  28: "internal-frame",
  29: "label",
  30: "layered-pane",
  31: "list",
  32: "list-item",
  33: "menu",
  34: "menu-bar",
  35: "menu-item",
  36: "option-pane",
  37: "page-tab",
  38: "page-tab-list",
  39: "panel",
  40: "password-text",
  41: "popup-menu",
  42: "progress-bar",
  43: "push-button",
  44: "radio-button",
  45: "radio-menu-item",
  46: "root-pane",
  47: "row-header",
  48: "scroll-bar",
  49: "scroll-pane",
  50: "separator",
  51: "slider",
  52: "spin-button",
  53: "split-pane",
  54: "status-bar",
  55: "table",
  56: "table-cell",
  57: "table-column-header",
  58: "table-row-header",
  59: "tearoff-menu-item",
  60: "terminal",
  61: "text",
  62: "toggle-button",
  63: "tool-bar",
  64: "tool-tip",
  65: "tree",
  66: "tree-table",
  67: "unknown",
  68: "viewport",
  69: "window",
  70: "extended",
  71: "header",
  72: "footer",
  73: "paragraph",
  74: "ruler",
  75: "application",
  76: "autocomplete",
  77: "edit-bar",
  78: "embedded",
  79: "entry",
  80: "chart",
  81: "caption",
  82: "document-frame",
  83: "heading",
  84: "page",
  85: "section",
  86: "redundant-object",
  87: "form",
  88: "link",
  89: "input-method-window",
  90: "table-row",
  91: "tree-item",
  92: "document-spreadsheet",
  93: "document-presentation",
  94: "document-text",
  95: "document-web",
  96: "document-email",
  97: "comment",
  98: "list-box",
  99: "grouping",
  100: "image-map",
  101: "notification",
  102: "info-bar",
  103: "level-bar",
  104: "title-bar",
  105: "block-quote",
  106: "audio",
  107: "video",
  108: "definition",
  109: "article",
  110: "landmark",
  111: "log",
  112: "marquee",
  113: "math",
  114: "rating",
  115: "timer",
  116: "static",
  117: "math-fraction",
  118: "math-root",
  119: "subscript",
  120: "superscript",
  121: "description-list",
  122: "description-term",
  123: "description-value",
  124: "footnote",
  125: "content-deletion",
  126: "content-insertion",
  127: "mark",
  128: "suggestion",
};

function getRoleName(roleId: number): string {
  return ROLE_NAMES[roleId] ?? "unknown";
}

interface AccessibleRef {
  busName: string;
  path: string;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Type for dbus-next interface with property getters
interface PropertiesInterface {
  Get(interfaceName: string, propertyName: string): Promise<dbus.Variant>;
}

// Type for accessible interface
interface AccessibleInterface {
  GetRole(): Promise<number>;
  GetChildAtIndex(index: number): Promise<[string, string]>;
}

// Type for component interface
interface ComponentInterface {
  GetExtents(coordType: number): Promise<[number, number, number, number]>;
}

// Cache of AT-SPI bus connections by session bus address
const a11yBusConnections = new Map<string, dbus.MessageBus>();

/**
 * Get the AT-SPI accessibility bus for a given session.
 * AT-SPI uses a separate bus from the session bus.
 *
 * @param dbusAddress - The session bus address (optional, uses env if not provided)
 */
async function getA11yBus(dbusAddress?: string): Promise<dbus.MessageBus> {
  // Use provided address or fall back to environment variable
  const sessionAddress = dbusAddress || process.env.DBUS_SESSION_BUS_ADDRESS || "";

  // Check cache first
  if (a11yBusConnections.has(sessionAddress)) {
    return a11yBusConnections.get(sessionAddress)!;
  }

  // First, get the A11y bus address from the session bus
  const sessionBus = getSessionBus(dbusAddress);
  const a11yBusProxy = await sessionBus.getProxyObject(ATSPI_BUS_NAME, ATSPI_BUS_PATH);
  const a11yBusIface = a11yBusProxy.getInterface(ATSPI_BUS_IFACE) as unknown as { GetAddress(): Promise<string> };

  // GetAddress returns the address of the accessibility bus
  const a11yAddress = await a11yBusIface.GetAddress();

  // Connect to the accessibility bus
  const a11yBus = dbus.sessionBus({ busAddress: a11yAddress });

  // Cache it
  a11yBusConnections.set(sessionAddress, a11yBus);

  return a11yBus;
}

/**
 * Get the extents (bounds) of an accessible element.
 */
async function getExtents(
  bus: dbus.MessageBus,
  ref: AccessibleRef
): Promise<Bounds | null> {
  try {
    const proxy = await bus.getProxyObject(ref.busName, ref.path);
    const component = proxy.getInterface(ATSPI_COMPONENT_IFACE) as unknown as ComponentInterface;

    // GetExtents(coord_type: uint32) -> (x: int32, y: int32, width: int32, height: int32)
    // coord_type 0 = SCREEN coordinates
    const extents = await component.GetExtents(0);
    const [x, y, width, height] = extents;

    if (width <= 0 || height <= 0) {
      return null;
    }

    return { x, y, width, height };
  } catch {
    // Element may not implement Component interface
    return null;
  }
}

/**
 * Get a DBus property value via the Properties interface.
 */
async function getProperty<T>(
  proxy: dbus.ProxyObject,
  interfaceName: string,
  propertyName: string
): Promise<T> {
  const props = proxy.getInterface(DBUS_PROPERTIES_IFACE) as unknown as PropertiesInterface;
  const variant = await props.Get(interfaceName, propertyName);
  return variant.value as T;
}

/**
 * Walk the accessible tree from a given reference.
 */
async function walkAccessible(
  bus: dbus.MessageBus,
  ref: AccessibleRef,
  depth: number = 0,
  maxDepth: number = 30
): Promise<A11yNode | null> {
  if (depth > maxDepth) {
    return null;
  }

  try {
    const proxy = await bus.getProxyObject(ref.busName, ref.path);
    const accessible = proxy.getInterface(ATSPI_ACCESSIBLE_IFACE) as unknown as AccessibleInterface;

    // Get role via method call
    const roleId = await accessible.GetRole();
    const role = getRoleName(roleId);

    // Get name via DBus Properties interface
    const name = await getProperty<string>(proxy, ATSPI_ACCESSIBLE_IFACE, "Name") ?? "";

    // Get bounds
    const bounds = await getExtents(bus, ref);

    // Skip elements with no bounds (invisible) unless top-level
    if (depth > 1 && bounds === null) {
      return null;
    }

    // Skip empty labels (often duplicates inside buttons)
    if (role === "label" && !name) {
      return null;
    }

    const result: A11yNode = {
      role,
      name,
    };

    if (bounds) {
      result.bounds = bounds;
    }

    // Get children count via DBus Properties interface
    const childCount = await getProperty<number>(proxy, ATSPI_ACCESSIBLE_IFACE, "ChildCount") ?? 0;
    const children: A11yNode[] = [];

    for (let i = 0; i < childCount; i++) {
      // GetChildAtIndex returns (bus_name: string, path: string)
      const childRef = await accessible.GetChildAtIndex(i);
      const [busName, path] = childRef;

      if (path === "/org/a11y/atspi/null") {
        continue;
      }

      const child = await walkAccessible(
        bus,
        { busName, path },
        depth + 1,
        maxDepth
      );

      if (child) {
        children.push(child);
      }
    }

    if (children.length > 0) {
      result.children = children;
    }

    return result;
  } catch (err) {
    // Log errors for debugging but continue
    if (depth === 0) {
      console.error("[A11y] Error walking tree:", err);
    }
    return null;
  }
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
 * Get the desktop accessibility tree using dbus-next.
 * This replaces the Python a11y-dump script.
 *
 * @param dbusAddress - The session bus address (optional, uses env if not provided)
 * @param maxDepth - Maximum tree depth to traverse (default 30)
 */
export async function getA11yTreeViaDBus(dbusAddress?: string, maxDepth: number = 30): Promise<A11yNode | null> {
  try {
    const bus = await getA11yBus(dbusAddress);

    // Get the registry (root of the accessibility tree)
    const registryProxy = await bus.getProxyObject(ATSPI_REGISTRY_NAME, ATSPI_REGISTRY_PATH);
    const registry = registryProxy.getInterface(ATSPI_ACCESSIBLE_IFACE) as unknown as AccessibleInterface;

    // Get child count (number of applications) via Properties interface
    const childCount = await getProperty<number>(registryProxy, ATSPI_ACCESSIBLE_IFACE, "ChildCount") ?? 0;

    // Build the desktop node
    const desktop: A11yNode = {
      role: "desktop-frame",
      name: "main",
      children: [],
    };

    // Walk each application
    for (let i = 0; i < childCount; i++) {
      const childRef = await registry.GetChildAtIndex(i);
      const [busName, path] = childRef;

      if (path === "/org/a11y/atspi/null") {
        continue;
      }

      const child = await walkAccessible(bus, { busName, path }, 1, maxDepth);
      if (child) {
        desktop.children!.push(child);
      }
    }

    // Add parent references
    addParentRefs(desktop);

    return desktop;
  } catch (err) {
    console.error("[A11y] Failed to get tree via DBus:", err);
    return null;
  }
}

/**
 * Close the AT-SPI bus connection for a specific session.
 *
 * @param dbusAddress - The session bus address (optional, closes all if not provided)
 */
export function closeA11yBus(dbusAddress?: string): void {
  if (dbusAddress) {
    const bus = a11yBusConnections.get(dbusAddress);
    if (bus) {
      bus.disconnect();
      a11yBusConnections.delete(dbusAddress);
    }
  } else {
    // Close all connections
    for (const [address, bus] of a11yBusConnections) {
      bus.disconnect();
      a11yBusConnections.delete(address);
    }
  }
}
