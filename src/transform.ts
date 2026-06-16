import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

export function getContentText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

export function transformTools(tools: Tool[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function transformMessagesForQoder(messages: Message[]): any[] {
  const normalizedMessages: any[] = [];

  for (const msg of messages) {
    // Skip error or aborted messages
    if (
      msg.role === "assistant" &&
      ((msg as AssistantMessage).stopReason === "error" || (msg as AssistantMessage).stopReason === "aborted")
    ) {
      continue;
    }

    if (msg.role === "user") {
      let content: any = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const hasImage = msg.content.some((c) => c.type === "image");
        if (hasImage) {
          content = msg.content
            .map((c) => {
              if (c.type === "text") {
                return { type: "text", text: (c as TextContent).text };
              }
              if (c.type === "image") {
                const img = c as ImageContent;
                return {
                  type: "image_url",
                  image_url: {
                    url: `data:${img.mimeType};base64,${img.data}`,
                  },
                };
              }
              return null;
            })
            .filter(Boolean);
        } else {
          content = getContentText(msg);
        }
      }
      normalizedMessages.push({
        role: "user",
        content,
      });
    } else if (msg.role === "assistant") {
      const am = msg as AssistantMessage;
      let content = "";
      const toolCalls: any[] = [];

      if (Array.isArray(am.content)) {
        for (const block of am.content) {
          if (block.type === "text") {
            content += (block as TextContent).text;
          } else if (block.type === "thinking") {
            // Include thinking tags if reasoning is on
            content += `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n`;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            toolCalls.push({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
              },
            });
          }
        }
      } else {
        content = am.content || "";
      }

      const mapped: any = {
        role: "assistant",
        content: content || null,
      };
      if (toolCalls.length > 0) {
        mapped.tool_calls = toolCalls;
      }
      normalizedMessages.push(mapped);
    } else if (msg.role === "toolResult") {
      const tr = msg as ToolResultMessage;
      normalizedMessages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: getContentText(tr),
      });
    }
  }

  return normalizedMessages;
}
