import fs from "fs";
import https from "https";
import { IncomingMessage } from "http";
import path from "path";

const URLS: Record<string, string> = {
  x64: "https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb",
  arm64: "https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_arm64.deb"
};

export type WeChatArch = "x64" | "arm64";

export function resolveWeChatArch(input?: string): WeChatArch {
  if (input === "x86_64" || input === "amd64") {
    return "x64";
  }
  if (input === "aarch64") {
    return "arm64";
  }
  if (input === "x64" || input === "arm64") {
    return input;
  }

  const arch = process.arch;
  if (arch === "x64" || arch === "arm64") {
    return arch;
  }

  throw new Error(`unsupported architecture: ${arch}`);
}

export function getWeChatUrl(arch: WeChatArch): string {
  const url = URLS[arch];
  if (!url) {
    throw new Error(`no download url for arch: ${arch}`);
  }
  return url;
}

export async function downloadWeChatDeb(
  targetPath: string,
  arch: WeChatArch,
  onProgress?: (received: number, total?: number) => void
): Promise<void> {
  const url = getWeChatUrl(arch);
  await new Promise<void>((resolve, reject) => {
    const tempPath = `${targetPath}.partial`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const handleResponse = (response: IncomingMessage) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        https.get(response.headers.location, handleResponse).on("error", reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`download failed: ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(tempPath);
      const total = response.headers["content-length"] ? Number(response.headers["content-length"]) : undefined;
      let received = 0;
      let lastEmit = Date.now();
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (onProgress) {
          const now = Date.now();
          if (now - lastEmit > 500 || (total && received >= total)) {
            lastEmit = now;
            onProgress(received, total);
          }
        }
      });
      response.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          fs.renameSync(tempPath, targetPath);
          resolve();
        });
      });
      file.on("error", (error) => {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore cleanup errors
        }
        reject(error);
      });
    };

    https.get(url, handleResponse).on("error", reject);
  });
}
