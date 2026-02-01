import fs from "fs";
import os from "os";
import path from "path";

export function getDefaultDataDir(): string {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "agent-wechat");
  }

  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "agent-wechat");
  }

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) {
    return path.join(xdg, "agent-wechat");
  }

  return path.join(home, ".local", "share", "agent-wechat");
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
