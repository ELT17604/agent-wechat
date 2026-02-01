import type { LanguageModelMiddleware } from "ai";

/**
 * Middleware that extracts image content from tool results into user messages.
 * Required for Gemini models which do not support images in tool results.
 *
 * When a tool returns content with image-data parts (via toModelOutput),
 * this middleware:
 * 1. Replaces the image in the tool result with a placeholder text
 * 2. Adds a user message after the tool result containing the actual image
 */
export function geminiContentSplitterMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      if (!params.prompt || !Array.isArray(params.prompt)) {
        return params;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newMessages: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pendingImages: Array<{ type: "file"; data: string; mediaType: string }> = [];

      const flushPendingImages = () => {
        if (pendingImages.length > 0) {
          newMessages.push({
            role: "user",
            content: [
              { type: "text", text: "The tool returned the following images:" },
              ...pendingImages,
            ],
          });
          pendingImages = [];
        }
      };

      for (let i = 0; i < params.prompt.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const message = params.prompt[i] as any;

        if (message.role === "tool") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const newContent: any[] = [];

          for (const part of message.content) {
            if (part.type === "tool-result" && part.output?.type === "content") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const newOutputValue: any[] = [];
              let hasImages = false;

              for (const outputPart of part.output.value) {
                if (outputPart.type === "image-data") {
                  // Extract image and convert to file format for user message
                  pendingImages.push({
                    type: "file",
                    data: outputPart.data,
                    mediaType: outputPart.mediaType ?? "image/png",
                  });
                  newOutputValue.push({
                    type: "text",
                    text: "[Image extracted and moved to user message]",
                  });
                  hasImages = true;
                } else {
                  newOutputValue.push(outputPart);
                }
              }

              if (hasImages) {
                newContent.push({
                  ...part,
                  output: {
                    type: "content",
                    value: newOutputValue,
                  },
                });
              } else {
                newContent.push(part);
              }
            } else {
              newContent.push(part);
            }
          }

          newMessages.push({
            ...message,
            content: newContent,
          });

          // Flush images after tool message block if next message is not a tool
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nextMessage = params.prompt[i + 1] as any;
          if (!nextMessage || nextMessage.role !== "tool") {
            flushPendingImages();
          }
        } else {
          flushPendingImages();
          newMessages.push(message);
        }
      }

      flushPendingImages();

      return {
        ...params,
        prompt: newMessages,
      };
    },
  };
}
