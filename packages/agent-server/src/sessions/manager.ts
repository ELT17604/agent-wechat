import { spawn, ChildProcess, execSync } from "child_process";
import { eq, or, max, sql } from "drizzle-orm";
import { getDb, sessions, chats, messages, syncState } from "../db/index.js";
import { randomUUID } from "crypto";
import type { Session, SessionStatus, LoginState } from "@thisnick/agent-wechat-shared";

interface SessionProcesses {
  xvfb?: ChildProcess;
  dbus?: ChildProcess;
  atSpi?: ChildProcess;
  wechat?: ChildProcess;
  vnc?: ChildProcess;
}

// Track running processes in memory
const runningProcesses = new Map<string, SessionProcesses>();

// Display and port allocation
const BASE_DISPLAY = 100;
const BASE_VNC_PORT = 5901;

/**
 * Convert DB row to Session object
 */
function dbRowToSession(row: typeof sessions.$inferSelect): Session {
  const loginState: LoginState =
    row.loginState === "logged_in"
      ? { status: "logged_in" }
      : row.loginState === "qr_pending"
        ? { status: "qr_pending" }
        : { status: "logged_out" };

  return {
    id: row.id,
    name: row.name,
    linuxUser: row.linuxUser,
    display: row.display,
    dbusAddress: row.dbusAddress ?? undefined,
    vncPort: row.vncPort ?? 0,
    status: row.status as SessionStatus,
    loginState,
    wechatPid: row.wechatPid ?? undefined,
    xvfbPid: row.xvfbPid ?? undefined,
    dbusPid: row.dbusPid ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * Get the next available display number
 */
function getNextDisplay(): number {
  const db = getDb();
  const result = db
    .select({ maxDisplay: max(sql<number>`CAST(SUBSTR(${sessions.display}, 2) AS INTEGER)`) })
    .from(sessions)
    .get();

  const maxDisplay = typeof result?.maxDisplay === "number" ? result.maxDisplay : null;
  return (maxDisplay ?? BASE_DISPLAY - 1) + 1;
}

/**
 * Get the next available VNC port
 */
function getNextVncPort(): number {
  const db = getDb();
  const result = db
    .select({ maxPort: max(sessions.vncPort) })
    .from(sessions)
    .get();

  const maxPort = typeof result?.maxPort === "number" ? result.maxPort : null;
  return (maxPort ?? BASE_VNC_PORT - 1) + 1;
}

/**
 * Create a new session
 */
export async function createSession(name: string): Promise<Session> {
  const db = getDb();

  // Check if name already exists
  const existing = db.select().from(sessions).where(eq(sessions.name, name)).get();
  if (existing) {
    throw new Error(`Session with name "${name}" already exists`);
  }

  const id = randomUUID();
  const displayNum = getNextDisplay();
  const display = `:${displayNum}`;
  const linuxUser = `wechat-${displayNum}`;
  const vncPort = getNextVncPort();

  // Create Linux user
  try {
    execSync(`useradd -m -s /bin/bash ${linuxUser}`, { stdio: "pipe" });
  } catch (err) {
    // User might already exist
    const error = err as { message: string };
    if (!error.message.includes("already exists")) {
      throw new Error(`Failed to create user ${linuxUser}: ${error.message}`);
    }
  }

  // Insert into database
  db.insert(sessions)
    .values({
      id,
      name,
      linuxUser,
      display,
      vncPort,
      status: "stopped",
      loginState: "logged_out",
    })
    .run();

  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  return dbRowToSession(row!);
}

/**
 * Get a session by ID or name
 */
export function getSession(idOrName: string): Session | null {
  const db = getDb();
  const row = db
    .select()
    .from(sessions)
    .where(or(eq(sessions.id, idOrName), eq(sessions.name, idOrName)))
    .get();

  return row ? dbRowToSession(row) : null;
}

/**
 * List all sessions
 */
export function listSessions(): Session[] {
  const db = getDb();
  const rows = db.select().from(sessions).orderBy(sessions.createdAt).all();
  return rows.map(dbRowToSession);
}

/**
 * Start a session (launches Xvfb, D-Bus, AT-SPI, WeChat)
 */
export async function startSession(idOrName: string): Promise<Session> {
  const session = getSession(idOrName);
  if (!session) {
    throw new Error(`Session not found: ${idOrName}`);
  }

  if (session.status === "running") {
    return session;
  }

  const db = getDb();

  try {
    // Update status to starting
    db.update(sessions)
      .set({ status: "starting", updatedAt: new Date().toISOString() })
      .where(eq(sessions.id, session.id))
      .run();

    const processes: SessionProcesses = {};
    const displayNum = session.display.slice(1); // Remove leading ':'
    const homeDir = `/home/${session.linuxUser}`;

    // 1. Start Xvfb
    const lockFile = `/tmp/.X${displayNum}-lock`;
    try {
      execSync(`rm -f ${lockFile}`, { stdio: "pipe" });
    } catch {
      // Ignore
    }

    processes.xvfb = spawn("Xvfb", [session.display, "-screen", "0", "1280x800x24"], {
      detached: true,
      stdio: "ignore",
    });
    processes.xvfb.unref();

    await sleep(500);

    // 2. Start D-Bus as the session user
    let dbusAddress = "";
    try {
      const dbusOutput = execSync(
        `su -s /bin/bash -c "dbus-launch --sh-syntax" ${session.linuxUser}`,
        { encoding: "utf-8" }
      );
      const match = dbusOutput.match(/DBUS_SESSION_BUS_ADDRESS='([^']+)'/);
      if (match) {
        dbusAddress = match[1];
      }
    } catch (err) {
      throw new Error(`Failed to start D-Bus: ${(err as Error).message}`);
    }

    // 3. Start fluxbox
    spawn("su", ["-s", "/bin/bash", "-c",
      `DISPLAY=${session.display} DBUS_SESSION_BUS_ADDRESS=${dbusAddress} HOME=${homeDir} fluxbox &`,
      session.linuxUser
    ], { detached: true, stdio: "ignore" }).unref();

    await sleep(500);

    // 4. Start AT-SPI
    processes.atSpi = spawn("su", ["-s", "/bin/bash", "-c",
      `DISPLAY=${session.display} DBUS_SESSION_BUS_ADDRESS=${dbusAddress} HOME=${homeDir} /usr/libexec/at-spi-bus-launcher &`,
      session.linuxUser
    ], { detached: true, stdio: "ignore" });
    processes.atSpi.unref();

    await sleep(1000);

    // 5. Start VNC
    processes.vnc = spawn("x11vnc", [
      "-display", session.display,
      "-forever", "-nopw",
      "-rfbport", session.vncPort.toString()
    ], { detached: true, stdio: "ignore" });
    processes.vnc.unref();

    // 6. Start WeChat
    processes.wechat = spawn("su", ["-s", "/bin/bash", "-c",
      `DISPLAY=${session.display} \
       DBUS_SESSION_BUS_ADDRESS=${dbusAddress} \
       QT_ACCESSIBILITY=1 \
       QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 \
       GTK_MODULES=gail:atk-bridge \
       HOME=${homeDir} \
       /usr/bin/wechat &`,
      session.linuxUser
    ], { detached: true, stdio: "ignore" });
    processes.wechat.unref();

    // Store processes
    runningProcesses.set(session.id, processes);

    // Update database
    db.update(sessions)
      .set({
        status: "running",
        dbusAddress,
        xvfbPid: processes.xvfb?.pid ?? null,
        wechatPid: processes.wechat?.pid ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(sessions.id, session.id))
      .run();

    return getSession(session.id)!;

  } catch (err) {
    // Update status to error
    db.update(sessions)
      .set({
        status: "error",
        errorMessage: (err as Error).message,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(sessions.id, session.id))
      .run();

    throw err;
  }
}

/**
 * Stop a session
 */
export async function stopSession(idOrName: string): Promise<Session> {
  const session = getSession(idOrName);
  if (!session) {
    throw new Error(`Session not found: ${idOrName}`);
  }

  if (session.status === "stopped") {
    return session;
  }

  const db = getDb();

  db.update(sessions)
    .set({ status: "stopping", updatedAt: new Date().toISOString() })
    .where(eq(sessions.id, session.id))
    .run();

  // Kill processes by user
  try {
    execSync(`pkill -u ${session.linuxUser}`, { stdio: "pipe" });
  } catch {
    // Ignore - processes might not exist
  }

  // Also kill Xvfb for this display
  try {
    execSync(`pkill -f "Xvfb ${session.display}"`, { stdio: "pipe" });
  } catch {
    // Ignore
  }

  // Clean up lock file
  const displayNum = session.display.slice(1);
  try {
    execSync(`rm -f /tmp/.X${displayNum}-lock`, { stdio: "pipe" });
  } catch {
    // Ignore
  }

  // Clear from memory
  runningProcesses.delete(session.id);

  // Update database
  db.update(sessions)
    .set({
      status: "stopped",
      dbusAddress: null,
      xvfbPid: null,
      wechatPid: null,
      dbusPid: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sessions.id, session.id))
    .run();

  return getSession(session.id)!;
}

/**
 * Delete a session
 */
export async function deleteSession(idOrName: string): Promise<void> {
  const session = getSession(idOrName);
  if (!session) {
    throw new Error(`Session not found: ${idOrName}`);
  }

  // Stop if running
  if (session.status === "running" || session.status === "starting") {
    await stopSession(session.id);
  }

  const db = getDb();

  // Delete associated data
  db.delete(syncState).where(eq(syncState.sessionId, session.id)).run();
  db.delete(messages).where(eq(messages.sessionId, session.id)).run();
  db.delete(chats).where(eq(chats.sessionId, session.id)).run();
  db.delete(sessions).where(eq(sessions.id, session.id)).run();

  // Delete Linux user
  try {
    execSync(`userdel -r ${session.linuxUser}`, { stdio: "pipe" });
  } catch {
    // User might not exist
  }
}

/**
 * Get or create default session.
 * The default session uses display :99, user "wechat", and VNC port 5900,
 * matching what entrypoint.sh sets up.
 */
export async function getOrCreateDefaultSession(): Promise<Session> {
  const db = getDb();
  let session = getSession("default");

  // If session exists but has wrong display, delete and recreate
  if (session && session.display !== ":99") {
    console.log(`[SessionManager] Fixing stale default session (was ${session.display}, should be :99)`);
    db.delete(sessions).where(eq(sessions.name, "default")).run();
    session = null;
  }

  if (!session) {
    // Create default session matching entrypoint.sh setup
    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(sessions)
      .values({
        id,
        name: "default",
        linuxUser: "wechat",
        display: ":99",
        dbusAddress: process.env.DBUS_SESSION_BUS_ADDRESS || null,
        vncPort: 5900,
        status: "running", // entrypoint.sh already started it
        loginState: "logged_out",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    session = getSession("default");
    if (!session) {
      throw new Error("Failed to create default session");
    }
  }
  return session;
}

/**
 * Start all sessions that were running before shutdown
 */
export async function startPreviouslyRunningSessions(): Promise<void> {
  const db = getDb();
  const runningSessions = db
    .select()
    .from(sessions)
    .where(eq(sessions.status, "running"))
    .all();

  // Reset status to stopped first (they're not actually running after restart)
  db.update(sessions)
    .set({ status: "stopped" })
    .where(eq(sessions.status, "running"))
    .run();

  for (const row of runningSessions) {
    const session = dbRowToSession(row);
    try {
      await startSession(session.id);
      console.log(`Restarted session: ${session.name}`);
    } catch (err) {
      console.error(`Failed to restart session ${session.name}:`, err);
    }
  }
}

/**
 * Initialize sessions on startup
 */
export async function initializeSessions(): Promise<void> {
  const allSessions = listSessions();

  if (allSessions.length === 0) {
    // Create and start default session
    console.log("No sessions found, creating default session...");
    const defaultSession = await createSession("default");
    await startSession(defaultSession.id);
  } else {
    // Start previously running sessions
    await startPreviouslyRunningSessions();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
