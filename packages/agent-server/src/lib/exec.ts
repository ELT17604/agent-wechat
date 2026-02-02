import { spawn } from "child_process";
import type { Session } from "@thisnick/agent-wechat-shared";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  session?: Session;
  timeout?: number;
}

/**
 * Execute a command with fixed arguments (no shell interpolation)
 *
 * If a session is provided, the command runs with that session's
 * DISPLAY and DBUS_SESSION_BUS_ADDRESS environment.
 */
export function execCommand(
  command: string,
  args: string[],
  options: ExecOptions = {}
): Promise<CommandResult> {
  const { session, timeout = 60000 } = options;

  return new Promise((resolve) => {
    // Build environment based on session context
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      QT_ACCESSIBILITY: "1",
      QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
    };

    if (session) {
      // Use session-specific environment
      env.DISPLAY = session.display;
      env.DBUS_SESSION_BUS_ADDRESS = session.dbusAddress || "";
      env.HOME = `/home/${session.linuxUser}`;
    } else {
      // Fall back to process environment or defaults
      env.DISPLAY = process.env.DISPLAY || ":99";
      env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS || "";
    }

    const proc = spawn(command, args, {
      env,
      timeout,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

/**
 * Legacy overload for backward compatibility
 */
export function execCommandSimple(
  command: string,
  args: string[],
  timeout: number = 60000
): Promise<CommandResult> {
  return execCommand(command, args, { timeout });
}
