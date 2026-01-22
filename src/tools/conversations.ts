/**
 * Chatwoot conversation management tools
 */

import { z } from "zod";
import { getClient } from "../services/chatwoot-client.js";
import { handleApiError } from "../services/error-handler.js";
import { ResponseFormat } from "../constants.js";
import {
  AccountIdSchema,
  PaginationSchema,
  ResponseFormatSchema,
} from "../schemas/common.js";

/**
 * Schema for listing conversations
 */
export const ListConversationsSchema = AccountIdSchema.merge(PaginationSchema)
  .merge(ResponseFormatSchema)
  .extend({
    status: z
      .enum(["open", "resolved", "pending", "snoozed", "all"])
      .default("open")
      .describe("Filter conversations by status"),
    assignee_type: z
      .enum(["me", "unassigned", "all"])
      .optional()
      .describe("Filter by assignee type"),
    inbox_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Filter conversations by inbox ID"),
  })
  .strict();

export type ListConversationsInput = z.infer<typeof ListConversationsSchema>;

/**
 * List conversations from Chatwoot
 */
export async function listConversations(params: ListConversationsInput) {
  try {
    const client = getClient();

    const { data, error, response } = await client.GET(
      "/api/v1/accounts/{account_id}/conversations",
      {
        params: {
          path: {
            account_id: params.account_id,
          },
          query: {
            page: params.page,
            status: params.status,
            assignee_type: params.assignee_type,
            inbox_id: params.inbox_id,
          } as any,
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

    const conversations = (data as any).data?.payload || [];
    const meta = (data as any).data?.meta || {};

    if (conversations.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No ${params.status} conversations found.`,
          },
        ],
      };
    }

    // Build structured output
    const output = {
      conversations: conversations.map((conv: any) => ({
        id: conv.id,
        inbox_id: conv.inbox_id,
        status: conv.status,
        contact: {
          id: conv.meta?.sender?.id,
          name: conv.meta?.sender?.name,
          email: conv.meta?.sender?.email,
        },
        assignee: conv.meta?.assignee
          ? {
              id: conv.meta.assignee.id,
              name: conv.meta.assignee.name,
            }
          : null,
        unread_count: conv.unread_count,
        last_activity_at: conv.last_activity_at,
        messages_count: conv.messages_count,
      })),
      meta: {
        current_page: meta.current_page,
        all_count: meta.all_count,
        mine_count: meta.mine_count,
        unassigned_count: meta.unassigned_count,
      },
    };

    // Format response based on requested format
    let textContent: string;
    if (params.response_format === ResponseFormat.MARKDOWN) {
      const lines = [
        `# Conversations (${params.status})`,
        "",
        `Total: ${meta.all_count || 0} | Page: ${params.page}`,
        "",
      ];

      for (const conv of output.conversations) {
        lines.push(`## Conversation #${conv.id}`);
        lines.push(`- **Status**: ${conv.status}`);
        lines.push(
          `- **Contact**: ${conv.contact.name} (${conv.contact.email || "no email"})`
        );
        lines.push(
          `- **Assignee**: ${conv.assignee ? conv.assignee.name : "Unassigned"}`
        );
        lines.push(`- **Messages**: ${conv.messages_count}`);
        lines.push(`- **Unread**: ${conv.unread_count}`);
        lines.push(
          `- **Last Activity**: ${new Date(conv.last_activity_at * 1000).toLocaleString()}`
        );
        lines.push("");
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
 * Schema for getting a single conversation
 */
export const GetConversationSchema = AccountIdSchema.extend({
  conversation_id: z
    .number()
    .int()
    .positive()
    .describe("The ID of the conversation"),
})
  .merge(ResponseFormatSchema)
  .strict();

export type GetConversationInput = z.infer<typeof GetConversationSchema>;

/**
 * Get a single conversation with full details
 */
export async function getConversation(params: GetConversationInput) {
  try {
    const client = getClient();

    const { data, error, response } = await client.GET(
      "/api/v1/accounts/{account_id}/conversations/{conversation_id}",
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

    const conv = data as any;

    const output = {
      id: conv.id,
      inbox_id: conv.inbox_id,
      status: conv.status,
      contact: {
        id: conv.meta?.sender?.id,
        name: conv.meta?.sender?.name,
        email: conv.meta?.sender?.email,
        phone_number: conv.meta?.sender?.phone_number,
      },
      assignee: conv.meta?.assignee
        ? {
            id: conv.meta.assignee.id,
            name: conv.meta.assignee.name,
            email: conv.meta.assignee.email,
          }
        : null,
      unread_count: conv.unread_count,
      last_activity_at: conv.last_activity_at,
      messages_count: conv.messages_count,
      labels: conv.labels || [],
      custom_attributes: conv.custom_attributes || {},
    };

    let textContent: string;
    if (params.response_format === ResponseFormat.MARKDOWN) {
      const lines = [
        `# Conversation #${output.id}`,
        "",
        `**Status**: ${output.status}`,
        `**Inbox ID**: ${output.inbox_id}`,
        "",
        `## Contact`,
        `- **Name**: ${output.contact.name}`,
        `- **Email**: ${output.contact.email || "N/A"}`,
        `- **Phone**: ${output.contact.phone_number || "N/A"}`,
        "",
        `## Assignee`,
        output.assignee
          ? `- **Name**: ${output.assignee.name}\n- **Email**: ${output.assignee.email}`
          : "- Unassigned",
        "",
        `## Statistics`,
        `- **Messages**: ${output.messages_count}`,
        `- **Unread**: ${output.unread_count}`,
        `- **Last Activity**: ${new Date(output.last_activity_at * 1000).toLocaleString()}`,
        "",
      ];

      if (output.labels.length > 0) {
        lines.push(`## Labels`);
        lines.push(`- ${output.labels.join(", ")}`);
        lines.push("");
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
