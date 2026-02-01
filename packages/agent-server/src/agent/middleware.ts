import type { LanguageModelMiddleware } from "ai";

/**
 * Middleware that handles image content from tool results for Gemini.
 * Gemini doesn't support images in tool results, so we extract them
 * and add them as a subsequent user message.
 */
export const geminiImageMiddleware: LanguageModelMiddleware = {
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
          if (part.type === "tool-result") {
            // Check if the output contains image data (from toModelOutput)
            // In v3, tool results use output.value array with content
            const output = part.output;
            if (output?.type === "content" && Array.isArray(output.value)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const newOutputValue: any[] = [];
              let hasImages = false;

              for (const outputPart of output.value) {
                if (outputPart.type === "image-data") {
                  // Extract image
                  pendingImages.push({
                    type: "file",
                    data: outputPart.data,
                    mediaType: outputPart.mediaType ?? "image/png",
                  });
                  newOutputValue.push({
                    type: "text",
                    text: "[Image extracted - see next message]",
                  });
                  hasImages = true;
                } else {
                  newOutputValue.push(outputPart);
                }
              }

              if (hasImages) {
                newContent.push({
                  ...part,
                  output: { type: "content", value: newOutputValue },
                });
              } else {
                newContent.push(part);
              }
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

        // Flush images after tool message block
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
