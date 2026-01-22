/**
 * Chatwoot message management tools
 */

import { z } from "zod";
import { getClient } from "../services/chatwoot-client.js";
import { handleApiError } from "../services/error-handler.js";
import { ResponseFormat } from "../constants.js";
import { AccountIdSchema, ResponseFormatSchema } from "../schemas/common.js";

/**
 * Schema for listing messages in a conversation
 */
export const ListMessagesSchema = AccountIdSchema.extend({
  conversation_id: z
    .number()
    .int()
    .positive()
    .describe("The ID of the conversation"),
})
  .merge(ResponseFormatSchema)
  .strict();

export type ListMessagesInput = z.infer<typeof ListMessagesSchema>;

/**
 * List all messages in a conversation
 */
export async function listMessages(params: ListMessagesInput) {
  try {
    const client = getClient();

    const { data, error, response } = await client.GET(
      "/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages",
      {
        params: {
          path: {
            account_id: params.account_id,
            conversation_id: params.conversation_id,
          },
        },
      }
    );

    if (error || !data) {
      return {
        content: [
          {
            type: "text" as const,
            text: handleApiError({ response, error }),
          },
        ],
      };
    }

    const messages = (data as any).payload || (data as any) || [];

    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No messages found in conversation #${params.conversation_id}`,
          },
        ],
      };
    }

    const output = {
      conversation_id: params.conversation_id,
      messages: messages.map((msg: any) => ({
        id: msg.id,
        content: msg.content,
        message_type: msg.message_type,
        created_at: msg.created_at,
        sender: msg.sender
          ? {
              id: msg.sender.id,
              name: msg.sender.name,
              type: msg.sender.type,
            }
          : null,
        attachments: msg.attachments || [],
        private: msg.private,
      })),
    };

    let textContent: string;
    if (params.response_format === ResponseFormat.MARKDOWN) {
      const lines = [
        `# Messages in Conversation #${params.conversation_id}`,
        "",
        `Total messages: ${messages.length}`,
        "",
      ];

      for (const msg of output.messages) {
        const timestamp = new Date(msg.created_at * 1000).toLocaleString();
        const senderName = msg.sender ? msg.sender.name : "Unknown";
        const senderType = msg.sender ? msg.sender.type : "";

        lines.push(`## Message #${msg.id}`);
        lines.push(`**From**: ${senderName} (${senderType})`);
        lines.push(`**Time**: ${timestamp}`);
        lines.push(`**Type**: ${msg.message_type}${msg.private ? " (Private)" : ""}`);
        lines.push("");
        lines.push(`> ${msg.content || "(no content)"}`);
        lines.push("");

        if (msg.attachments.length > 0) {
          lines.push(`**Attachments**: ${msg.attachments.length} file(s)`);
          lines.push("");
        }
      }

      textContent = lines.join("\n");
    } else {
      textContent = JSON.stringify(output, null, 2);
    }

    return {
      content: [{ type: "text" as const, text: textContent }],
      structuredContent: output,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: handleApiError(error),
        },
      ],
    };
  }
}

/**
 * Schema for creating a message
 */
export const CreateMessageSchema = AccountIdSchema.extend({
  conversation_id: z
    .number()
    .int()
    .positive()
    .describe("The ID of the conversation"),
  content: z.string().min(1).describe("The message content"),
  message_type: z
    .enum(["outgoing", "incoming"])
    .default("outgoing")
    .describe("The type of message"),
  private: z
    .boolean()
    .default(false)
    .describe("Whether the message is private (internal note)"),
}).strict();

export type CreateMessageInput = z.infer<typeof CreateMessageSchema>;

/**
 * Create a new message in a conversation
 */
export async function createMessage(params: CreateMessageInput) {
  try {
    const client = getClient();

    const { data, error, response } = await client.POST(
      "/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages",
      {
        params: {
          path: {
            account_id: params.account_id,
            conversation_id: params.conversation_id,
          },
        },
        body: {
          content: params.content,
          message_type: params.message_type,
          private: params.private,
        } as any,
      }
    );

    if (error || !data) {
      return {
        content: [
          {
            type: "text" as const,
            text: handleApiError({ response, error }),
          },
        ],
      };
    }

    const message = data as any;

    const output = {
      id: message.id,
      content: message.content,
      message_type: message.message_type,
      created_at: message.created_at,
      conversation_id: params.conversation_id,
      private: message.private,
    };

    const textContent = `Message #${output.id} created successfully in conversation #${params.conversation_id}`;

    return {
      content: [{ type: "text" as const, text: textContent }],
      structuredContent: output,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: handleApiError(error),
        },
      ],
    };
  }
}
