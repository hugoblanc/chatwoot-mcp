#!/usr/bin/env node
/**
 * Chatwoot MCP Server
 *
 * Model Context Protocol server for Chatwoot API integration.
 * Provides tools to manage conversations, messages, and contacts in Chatwoot.
 */

import dotenv from "dotenv";

// Load environment variables from .env file (for development)
dotenv.config();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeClient } from "./services/chatwoot-client.js";
import {
  listConversations,
  ListConversationsSchema,
  getConversation,
  GetConversationSchema,
} from "./tools/conversations.js";
import {
  listMessages,
  ListMessagesSchema,
  createMessage,
  CreateMessageSchema,
} from "./tools/messages.js";

// Validate environment variables
function validateEnv() {
  if (!process.env.CHATWOOT_BASE_URL) {
    console.error("ERROR: CHATWOOT_BASE_URL is required");
    console.error("\nPlease set:");
    console.error("  CHATWOOT_BASE_URL - Your Chatwoot instance URL");
    console.error("\nAuthentication options:");
    console.error("  Option 1 (recommended): CHATWOOT_API_TOKEN - Your API access token (no expiration)");
    console.error("  Option 2: CHATWOOT_EMAIL + CHATWOOT_PASSWORD - For JWT auth (tokens expire)");
    process.exit(1);
  }

  const apiToken = process.env.CHATWOOT_API_TOKEN;
  const email = process.env.CHATWOOT_EMAIL;
  const password = process.env.CHATWOOT_PASSWORD;

  // Validate authentication method
  if (!apiToken && !email) {
    console.error("ERROR: Either CHATWOOT_API_TOKEN or CHATWOOT_EMAIL must be provided");
    process.exit(1);
  }

  return {
    baseUrl: process.env.CHATWOOT_BASE_URL!,
    apiAccessToken: apiToken,
    email,
    password,
  };
}

async function main() {
  // Validate and get configuration
  const config = validateEnv();

  // Initialize Chatwoot client (API token or JWT)
  await initializeClient({
    baseUrl: config.baseUrl,
    apiAccessToken: config.apiAccessToken,
    email: config.email,
    password: config.password,
  });

  // Create MCP server
  const server = new McpServer({
    name: "chatwoot-mcp-server",
    version: "1.0.0",
  });

  // Register tools
  // Conversations
  server.registerTool(
    "chatwoot_list_conversations",
    {
      title: "List Chatwoot Conversations",
      description: `List conversations from a Chatwoot account with filtering options.

This tool retrieves conversations from Chatwoot, allowing you to filter by status, assignee, and inbox. Supports pagination for large result sets.

Args:
  - account_id (number): The numeric ID of the Chatwoot account (required)
  - page (number): Page number for pagination, starts at 1 (default: 1)
  - status (string): Filter by conversation status - "open", "resolved", "pending", "snoozed", or "all" (default: "open")
  - assignee_type (string): Filter by assignee - "me", "unassigned", or "all" (optional)
  - inbox_id (number): Filter by specific inbox ID (optional)
  - response_format (string): Output format - "markdown" or "json" (default: "markdown")

Returns:
  A list of conversations with details including:
  - Conversation ID, status, and inbox
  - Contact information (name, email)
  - Assignee details
  - Message count and unread count
  - Last activity timestamp

Examples:
  - List all open conversations: { account_id: 1, status: "open" }
  - List unassigned conversations: { account_id: 1, assignee_type: "unassigned" }
  - List conversations in specific inbox: { account_id: 1, inbox_id: 5 }`,
      inputSchema: ListConversationsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listConversations
  );

  server.registerTool(
    "chatwoot_get_conversation",
    {
      title: "Get Chatwoot Conversation Details",
      description: `Get detailed information about a specific Chatwoot conversation.

This tool retrieves full details for a single conversation including contact info, assignee, labels, and custom attributes.

Args:
  - account_id (number): The numeric ID of the Chatwoot account (required)
  - conversation_id (number): The ID of the conversation to retrieve (required)
  - response_format (string): Output format - "markdown" or "json" (default: "markdown")

Returns:
  Full conversation details including:
  - Status, inbox, and metadata
  - Complete contact information
  - Assignee details
  - Labels and custom attributes
  - Message statistics

Examples:
  - Get conversation details: { account_id: 1, conversation_id: 123 }`,
      inputSchema: GetConversationSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    getConversation
  );

  // Messages
  server.registerTool(
    "chatwoot_list_messages",
    {
      title: "List Messages in Conversation",
      description: `List all messages in a Chatwoot conversation.

This tool retrieves all messages from a specific conversation, including message content, sender information, timestamps, and attachments.

Args:
  - account_id (number): The numeric ID of the Chatwoot account (required)
  - conversation_id (number): The ID of the conversation (required)
  - response_format (string): Output format - "markdown" or "json" (default: "markdown")

Returns:
  List of messages with:
  - Message ID and content
  - Message type (incoming/outgoing)
  - Sender information (name, type)
  - Timestamp
  - Attachment information
  - Private flag (for internal notes)

Examples:
  - List all messages: { account_id: 1, conversation_id: 123 }`,
      inputSchema: ListMessagesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listMessages
  );

  server.registerTool(
    "chatwoot_create_message",
    {
      title: "Create Message in Conversation",
      description: `Create a new message in a Chatwoot conversation.

This tool sends a message in an existing conversation. Can be used for outgoing messages to customers or private internal notes.

Args:
  - account_id (number): The numeric ID of the Chatwoot account (required)
  - conversation_id (number): The ID of the conversation (required)
  - content (string): The message content (required)
  - message_type (string): Type of message - "outgoing" or "incoming" (default: "outgoing")
  - private (boolean): Whether this is a private internal note (default: false)

Returns:
  Created message details including ID and confirmation

Examples:
  - Send a reply: { account_id: 1, conversation_id: 123, content: "Thank you for contacting us!" }
  - Add internal note: { account_id: 1, conversation_id: 123, content: "Customer called for follow-up", private: true }`,
      inputSchema: CreateMessageSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createMessage
  );

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Chatwoot MCP server running on stdio");
  console.error(`Connected to: ${config.baseUrl}`);
}

// Run server
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
