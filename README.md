# Chatwoot MCP Server

Model Context Protocol (MCP) server for Chatwoot API integration. Enables AI assistants to manage customer conversations, messages, and contacts in Chatwoot.

## Features

- **Conversations Management**: List, filter, and retrieve conversation details
- **Message Operations**: Read message history and send new messages
- **Type-Safe**: Built with TypeScript using OpenAPI-generated types
- **Flexible Auth**: Supports both API token (recommended) and JWT authentication

## Tools Provided

### Conversations

- `chatwoot_list_conversations` - List conversations with filtering (status, assignee, inbox)
- `chatwoot_get_conversation` - Get detailed info for a specific conversation

### Messages

- `chatwoot_list_messages` - List all messages in a conversation
- `chatwoot_create_message` - Send a message or create an internal note

## Installation

```bash
npm install
npm run build
```

## Configuration

### Recommended: API Access Token

The simplest method using your Chatwoot API token (no expiration).

**Get your API token:**
1. Log in to your Chatwoot account
2. Click your avatar → Profile Settings
3. Scroll to bottom → Copy your "Access Token"

**Configure `.env`:**
```bash
CHATWOOT_BASE_URL="https://your-chatwoot-instance.com"
CHATWOOT_API_TOKEN="your_api_token_here"
```

### Alternative: JWT Authentication

Use email/password if API tokens don't work on your instance (requires password for token refresh).

```bash
CHATWOOT_BASE_URL="https://your-chatwoot-instance.com"
CHATWOOT_EMAIL="your@email.com"
CHATWOOT_PASSWORD="your_password"
```

**Note:** JWT tokens expire and require the password for auto-refresh.

### Important for Self-Hosted Instances

If using nginx as reverse proxy (e.g., CapRover), add this to nginx config to support API tokens:

```nginx
server {
    ...
    underscores_in_headers on;  # Required for api_access_token header
    ...
}
```

## Usage

### Running the Server

```bash
npm start
```

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Using with Claude Code

```bash
claude mcp add chatwoot \
  -e CHATWOOT_BASE_URL="https://your-instance.com" \
  -e CHATWOOT_API_TOKEN="your_token" \
  -- node /path/to/chatwoot-mcp-server/dist/index.js
```

### Using with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chatwoot": {
      "command": "node",
      "args": ["/path/to/chatwoot-mcp-server/dist/index.js"],
      "env": {
        "CHATWOOT_BASE_URL": "https://your-chatwoot-instance.com",
        "CHATWOOT_API_TOKEN": "your_api_token"
      }
    }
  }
}
```

## Example Queries

Once connected, you can ask Claude things like:

- "Show me all open conversations in account 3"
- "What are the details of conversation #123?"
- "List all messages in conversation #456"
- "Send a reply to conversation #789 saying 'Thank you for contacting us!'"
- "Add an internal note to conversation #101 about the customer's issue"

## Testing

Run integration tests:

```bash
npm test
```

Watch mode:
```bash
npm run test:watch
```

## Project Structure

```
chatwoot-mcp-server/
├── src/
│   ├── index.ts                  # Main server entry point
│   ├── constants.ts              # Shared constants
│   ├── chatwoot-types.ts         # Generated OpenAPI types
│   ├── services/
│   │   ├── chatwoot-client.ts    # API client with auth
│   │   ├── chatwoot-auth.ts      # JWT authentication
│   │   ├── token-cache.ts        # JWT token caching
│   │   └── error-handler.ts      # Error handling utilities
│   ├── schemas/
│   │   └── common.ts             # Shared Zod schemas
│   └── tools/
│       ├── conversations.ts      # Conversation tools
│       └── messages.ts           # Message tools
├── test/                         # Integration tests
├── swagger.json                  # Chatwoot OpenAPI spec
└── package.json
```

## Development

### Regenerating Types

If the Chatwoot API changes, regenerate types:

```bash
npm run generate-types
```

### Adding New Tools

1. Create a new file in `src/tools/`
2. Define Zod schemas for input validation
3. Implement the tool function
4. Register the tool in `src/index.ts`

### Building

```bash
npm run build
```

Builds TypeScript to JavaScript in the `dist/` directory.

## Troubleshooting

### API Token Returns 401

If using a self-hosted instance with nginx, ensure `underscores_in_headers on;` is set in your nginx config. This is required because `api_access_token` contains underscores.

### JWT Tokens Expire

If using JWT authentication, tokens expire (typically after 2 weeks). Keep `CHATWOOT_PASSWORD` in `.env` for automatic refresh, or switch to API token authentication.

## Tech Stack

- **TypeScript** - Type-safe development
- **openapi-fetch** - Type-safe API client
- **openapi-typescript** - Generate types from OpenAPI spec
- **Zod** - Runtime input validation
- **@modelcontextprotocol/sdk** - MCP server framework
- **Vitest** - Testing framework

## License

MIT

## Contributing

Contributions are welcome! Additional tools that could be added:

- Contact management (create, update, search)
- Team and agent operations
- Inbox configuration
- Labels and custom attributes
- Reports and analytics
- Bulk operations
