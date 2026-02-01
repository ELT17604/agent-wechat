import { generateText, wrapLanguageModel, stepCountIs } from "ai";
import { google } from "@ai-sdk/google";
import { allTools } from "./tools.js";
import { geminiImageMiddleware } from "./middleware.js";
import {
  SYSTEM_PROMPT,
  LIST_CHATS_PROMPT,
  FIND_CHAT_PROMPT,
  OPEN_CHAT_PROMPT,
  SEND_MESSAGE_PROMPT,
  GET_MESSAGES_PROMPT,
} from "./prompts.js";
import { DEFAULT_AGENT_CONFIG } from "@thisnick/agent-wechat-shared";
import { getDb } from "../db/index.js";
import { getChatsFromDb, findChatsByName, getMessagesFromDb } from "../db/queries.js";
import type { Chat, Message, SendResult } from "@thisnick/agent-wechat-shared";

// Create model with middleware for image handling
const baseModel = google("gemini-3-flash-preview");
const model = wrapLanguageModel({
  model: baseModel,
  middleware: geminiImageMiddleware,
});

// Agent configuration
const config = {
  maxSteps: DEFAULT_AGENT_CONFIG.maxTurns,
};

// Helper to get tool name from a tool call
function getToolName(tc: unknown): string {
  if (typeof tc === "object" && tc !== null && "toolName" in tc) {
    return (tc as { toolName: string }).toolName;
  }
  return "unknown";
}

interface AgentResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  steps: number;
}

/**
 * Run the agent with a specific task
 */
async function runAgent<T>(
  taskPrompt: string,
  parseResult: (text: string) => T
): Promise<AgentResult<T>> {
  try {
    const result = await generateText({
      model,
      tools: allTools,
      stopWhen: stepCountIs(config.maxSteps),
      system: SYSTEM_PROMPT,
      prompt: taskPrompt,
      onStepFinish: (stepResult) => {
        // Log progress for debugging
        if (process.env.DEBUG) {
          console.log(`[Agent] Step finished`);
          if (stepResult.toolCalls?.length) {
            console.log(`[Agent] Tool calls: ${stepResult.toolCalls.map(tc => getToolName(tc)).join(", ")}`);
          }
        }
      },
    });

    return {
      success: true,
      data: parseResult(result.text),
      steps: result.steps.length,
    };
  } catch (error) {
    console.error("[Agent] Error:", error);
    return {
      success: false,
      error: String(error),
      steps: 0,
    };
  }
}

/**
 * List chats agent - syncs chat list from WeChat UI to database
 */
export async function runListChatsAgent(): Promise<Chat[]> {
  const result = await runAgent<Chat[]>(
    LIST_CHATS_PROMPT,
    () => {
      // The agent saves chats to DB via tools, so we fetch from DB
      const db = getDb();
      return getChatsFromDb(db, 100, false);
    }
  );

  if (!result.success) {
    console.error(`[ListChatsAgent] Failed: ${result.error}`);
    return [];
  }

  return result.data || [];
}

/**
 * Find chat agent - searches for a chat by name
 */
export async function runFindChatAgent(name: string): Promise<Chat[]> {
  const result = await runAgent<Chat[]>(
    FIND_CHAT_PROMPT(name),
    () => {
      const db = getDb();
      return findChatsByName(db, name);
    }
  );

  if (!result.success) {
    console.error(`[FindChatAgent] Failed: ${result.error}`);
    return [];
  }

  return result.data || [];
}

/**
 * Open chat agent - navigates to a specific chat
 */
export async function runOpenChatAgent(chatId: string): Promise<{ success: boolean }> {
  const result = await runAgent<{ success: boolean }>(
    OPEN_CHAT_PROMPT(chatId),
    (text) => {
      // Parse success from agent's response
      const lower = text.toLowerCase();
      return { success: lower.includes("success") || lower.includes("opened") };
    }
  );

  return { success: result.success };
}

/**
 * Send message agent - sends a message to a chat
 */
export async function runSendMessageAgent(
  chatId: string,
  text?: string,
  files?: string[]
): Promise<SendResult> {
  if (!text && (!files || files.length === 0)) {
    return { success: false, error: "No message content provided" };
  }

  // For now, only support text messages
  if (files && files.length > 0) {
    return { success: false, error: "File sending not yet implemented" };
  }

  const result = await runAgent<SendResult>(
    SEND_MESSAGE_PROMPT(chatId, text || ""),
    (responseText) => {
      const lower = responseText.toLowerCase();
      if (lower.includes("success") || lower.includes("sent")) {
        return { success: true };
      }
      return { success: false, error: responseText };
    }
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return result.data || { success: false, error: "Unknown error" };
}

/**
 * Get messages agent - syncs messages from a chat
 */
export async function runGetMessagesAgent(
  chatId: string,
  maxMessages: number = 50
): Promise<Message[]> {
  const result = await runAgent<Message[]>(
    GET_MESSAGES_PROMPT(chatId, maxMessages),
    () => {
      const db = getDb();
      return getMessagesFromDb(db, chatId, maxMessages);
    }
  );

  if (!result.success) {
    console.error(`[GetMessagesAgent] Failed: ${result.error}`);
    return [];
  }

  return result.data || [];
}
