import type { ResolvedWeChatAccount } from "./types.js";

export interface AccountSnapshot {
  accountId: string;
  account: ResolvedWeChatAccount;
  running: boolean;
  connected: boolean;
  linked?: boolean;
  lastError?: string;
}

export interface StatusIssue {
  channel: string;
  accountId: string;
  kind: "auth" | "runtime";
  message: string;
  fix: string;
}

export async function collectWeChatStatusIssues(
  accounts: AccountSnapshot[],
): Promise<StatusIssue[]> {
  const issues: StatusIssue[] = [];

  for (const snapshot of accounts) {
    if (!snapshot.connected) {
      issues.push({
        channel: "wechat",
        accountId: snapshot.accountId,
        kind: "runtime",
        message: snapshot.lastError
          ? `Cannot reach agent-wechat server: ${snapshot.lastError}`
          : "Cannot reach agent-wechat server.",
        fix: "Ensure the agent-wechat container is running (pnpm cli up)",
      });
    } else if (snapshot.linked === false) {
      issues.push({
        channel: "wechat",
        accountId: snapshot.accountId,
        kind: "auth",
        message: "WeChat session not authenticated.",
        fix: "Run: openclaw channels login --channel wechat",
      });
    }
  }

  return issues;
}
