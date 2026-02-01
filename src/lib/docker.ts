import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let cachedDockerHost: string | null | undefined;

export function execDocker(args: string[], options: { stdio?: "pipe" | "inherit" } = {}): DockerResult {
  const resolvedHost = resolveDockerHost();
  const env = resolvedHost ? { ...process.env, DOCKER_HOST: resolvedHost } : process.env;
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    env
  });

  return {
    stdout: result.stdout ? String(result.stdout) : "",
    stderr: result.stderr ? String(result.stderr) : "",
    exitCode: result.status ?? 1
  };
}

export function ensureDocker(): void {
  const result = execDocker(["info"]);
  if (result.exitCode !== 0) {
    throw new Error(`docker not available: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function resolveDockerHost(): string | undefined {
  if (process.env.DOCKER_HOST) {
    return undefined;
  }

  if (cachedDockerHost !== undefined) {
    return cachedDockerHost || undefined;
  }

  if (process.platform === "darwin") {
    const colimaSocket = path.join(os.homedir(), ".colima", "default", "docker.sock");
    if (fs.existsSync(colimaSocket)) {
      cachedDockerHost = `unix://${colimaSocket}`;
      return cachedDockerHost;
    }

    const hostFromColima = readColimaDockerHost();
    if (hostFromColima) {
      cachedDockerHost = hostFromColima;
      return cachedDockerHost;
    }
  }

  cachedDockerHost = null;
  return undefined;
}

function readColimaDockerHost(): string | undefined {
  const result = spawnSync("colima", ["docker-env"], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return undefined;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = output.match(/DOCKER_HOST=([^\n\r;]+)/);
  if (!match) {
    return undefined;
  }

  let host = match[1].trim();
  host = host.replace(/^"+|"+$/g, "");
  if (!host) {
    return undefined;
  }

  return host;
}
