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

### Via npm (recommended)

```bash
npx chatwoot-mcp-server
```

Or install globally:

```bash
npm install -g chatwoot-mcp-server
chatwoot-mcp-server
```

### From source

```bash
git clone https://github.com/hugoblanc/chatwoot-mcp.git
cd chatwoot-mcp
npm install
npm run build
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CHATWOOT_BASE_URL` | Yes | — | Your Chatwoot instance URL, e.g. `https://app.chatwoot.com` |
| `CHATWOOT_API_KEY` | For OAuth | — | Single-tenant Chatwoot API key. Required to enable the OAuth path (see below). |
| `MCP_OAUTH_SIGNING_SECRET` | For OAuth | — | Base64 or hex string, min 32 bytes. Enables the OAuth 2.0 + PKCE endpoints. Generate with `openssl rand -base64 48`. |
| `MCP_OAUTH_ISSUER` | For OAuth | — | Public base URL of this server, e.g. `https://your-chatwoot.example.com`. Used as `iss` in issued JWTs and in discovery documents. |
| `MCP_PORT` | No | `3198` | Port the HTTP server listens on. |
| `MCP_HOST` | No | `127.0.0.1` | Bind address. Use `0.0.0.0` only if you are not behind a reverse proxy. |

### Recommended: API Access Token

The simplest method using your Chatwoot API token (no expiration).

**Get your API token:**
1. Log in to your Chatwoot account
2. Click your avatar → Profile Settings
3. Scroll to bottom → Copy your "Access Token"

**Configure `.env`:**
```bash
CHATWOOT_BASE_URL="https://your-chatwoot-instance.com"
CHATWOOT_API_KEY="your_api_token_here"
```

### OAuth 2.0 + PKCE (for MCP clients that require OAuth)

The HTTP server ships a built-in single-tenant OAuth 2.0 authorization server so it can be used by MCP clients that require OAuth and cannot send a static Bearer token directly (e.g. hosted clients that implement the MCP authorization spec).

**How it works (single-tenant design):**

- The `/oauth/authorize` endpoint auto-approves immediately — no login page, no consent screen.
- The OAuth flow issues a short-lived HS256 JWT that proves "the caller completed PKCE on our server".
- On every `/mcp` request, the server verifies the JWT locally and maps it to the env-baked `CHATWOOT_API_KEY`. The JWT itself carries no Chatwoot credential.
- The existing static Bearer / `api-access-token` path continues to work unchanged.

**Security note:** Anyone who knows `MCP_OAUTH_SIGNING_SECRET` can mint valid access tokens that will be mapped to your `CHATWOOT_API_KEY`. Keep the secret private. Do not expose the OAuth endpoints on a multi-user or public deployment without adding additional access controls.

**Enable OAuth — add to `.env`:**
```bash
CHATWOOT_BASE_URL="https://your-chatwoot-instance.com"
CHATWOOT_API_KEY="your_chatwoot_api_token"
MCP_OAUTH_SIGNING_SECRET="$(openssl rand -base64 48)"
MCP_OAUTH_ISSUER="https://chat.your-domain.com"
```

**OAuth endpoints exposed when enabled:**

| Endpoint | Method | Description |
|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 discovery document |
| `/.well-known/oauth-protected-resource` | GET | RFC 9728 resource metadata (also matches `/mcp` suffix) |
| `/oauth/register` | POST | RFC 7591 Dynamic Client Registration (stateless) |
| `/oauth/authorize` | GET | Authorization endpoint — auto-approves, redirects with code |
| `/oauth/token` | POST | Token endpoint — validates PKCE, issues HS256 JWT |

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

### Using with Claude Code

```bash
claude mcp add chatwoot \
  -e CHATWOOT_BASE_URL="https://your-instance.com" \
  -e CHATWOOT_API_TOKEN="your_token" \
  -- npx chatwoot-mcp-server
```

### Using with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chatwoot": {
      "command": "npx",
      "args": ["chatwoot-mcp-server"],
      "env": {
        "CHATWOOT_BASE_URL": "https://your-chatwoot-instance.com",
        "CHATWOOT_API_TOKEN": "your_api_token"
      }
    }
  }
}
```

### Development Mode (from source)

```bash
npm run dev
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
