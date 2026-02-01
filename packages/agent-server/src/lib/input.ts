import { execCommand } from "./exec.js";

/**
 * Click at screen coordinates using xdotool
 */
export async function click(x: number, y: number, button: 1 | 2 | 3 = 1): Promise<void> {
  // Validate inputs are numbers to prevent injection
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Invalid coordinates");
  }

  const result = await execCommand("xdotool", [
    "mousemove",
    String(Math.round(x)),
    String(Math.round(y)),
    "click",
    String(button),
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Click failed: ${result.stderr}`);
  }
}

/**
 * Type text using xdotool with clipboard paste (Unicode-safe)
 * This uses xclip to copy to clipboard, then xdotool to paste
 */
export async function typeText(text: string): Promise<void> {
  // First, copy text to clipboard using xclip
  // We use stdin to pass the text, avoiding shell escaping issues
  const xclipResult = await execCommandWithStdin("xclip", ["-selection", "clipboard"], text);

  if (xclipResult.exitCode !== 0) {
    throw new Error(`Failed to copy to clipboard: ${xclipResult.stderr}`);
  }

  // Small delay for clipboard to be ready
  await sleep(50);

  // Paste using Ctrl+V
  const pasteResult = await execCommand("xdotool", ["key", "ctrl+v"]);

  if (pasteResult.exitCode !== 0) {
    throw new Error(`Failed to paste: ${pasteResult.stderr}`);
  }

  // Small delay after paste
  await sleep(50);
}

/**
 * Press a key or key combination using xdotool
 */
export async function pressKey(combo: string): Promise<void> {
  // Validate key combo - only allow alphanumeric, +, and common key names
  if (!/^[a-zA-Z0-9+_]+$/.test(combo)) {
    throw new Error(`Invalid key combo: ${combo}`);
  }

  const result = await execCommand("xdotool", ["key", combo]);

  if (result.exitCode !== 0) {
    throw new Error(`Key press failed: ${result.stderr}`);
  }
}

/**
 * Scroll up or down using xdotool
 */
export async function scroll(direction: "up" | "down", amount: number = 3): Promise<void> {
  // Validate amount
  if (!Number.isFinite(amount) || amount < 1 || amount > 100) {
    throw new Error("Invalid scroll amount");
  }

  // Button 4 = scroll up, Button 5 = scroll down
  const button = direction === "up" ? "4" : "5";

  const result = await execCommand("xdotool", [
    "click",
    "--repeat",
    String(Math.round(amount)),
    button,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Scroll failed: ${result.stderr}`);
  }
}

// Helper to execute command with stdin input
import { spawn } from "child_process";

function execCommandWithStdin(
  command: string,
  args: string[],
  stdin: string,
  timeout: number = 60000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":99",
      },
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

    // Write to stdin and close it
    proc.stdin.write(stdin);
    proc.stdin.end();

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
