import { execCommand, type ExecOptions } from "./exec.js";
import fs from "fs/promises";

/**
 * Capture a screenshot and return as base64-encoded PNG
 * Uses the screenshot command which saves to a temp file
 */
export async function captureScreenshot(options?: ExecOptions): Promise<string> {
  // screenshot returns the path to the saved file
  const result = await execCommand("screenshot", [], options);

  if (result.exitCode !== 0) {
    throw new Error(`Screenshot failed: ${result.stderr}`);
  }

  const filepath = result.stdout.trim();

  try {
    // Read the file and encode as base64
    const buffer = await fs.readFile(filepath);
    return buffer.toString("base64");
  } finally {
    // Clean up temp file
    await fs.unlink(filepath).catch(() => {});
  }
}

/**
 * Capture a screenshot and save to specified path
 */
export async function captureScreenshotToFile(outputPath: string, options?: ExecOptions): Promise<string> {
  const result = await execCommand("screenshot", ["--file", outputPath], options);

  if (result.exitCode !== 0) {
    throw new Error(`Screenshot failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * Capture a screenshot and return the temp file path
 * Caller is responsible for cleanup
 */
export async function captureScreenshotToTemp(options?: ExecOptions): Promise<string> {
  const result = await execCommand("screenshot", [], options);

  if (result.exitCode !== 0) {
    throw new Error(`Screenshot failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}
