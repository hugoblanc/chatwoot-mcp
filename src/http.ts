#!/usr/bin/env node

/**
 * Chatwoot MCP Server — HTTP / Streamable HTTP transport.
 *
 * Auth (two paths, both kept working simultaneously):
 *
 *   Static-Bearer (per-request raw token — works for any stdio/HTTP client):
 *     Authorization: Bearer <chatwoot-api-key>
 *     api-access-token: <chatwoot-api-key>
 *   The raw token is forwarded directly to the Chatwoot API.
 *
 *   OAuth 2.0 + PKCE (for MCP clients that require OAuth and cannot send a
 *   static Bearer header — e.g. hosted clients that only speak the OAuth
 *   flow defined in the MCP authorization spec):
 *     Authorization: Bearer <hs256-jwt>
 *   The JWT is verified locally; on success, the env-baked CHATWOOT_API_KEY
 *   is used as the upstream Chatwoot token. The JWT carries no Chatwoot
 *   credential — the server-side mapping is the security boundary.
 *
 * JWT shape detection: if the Bearer value has exactly three base64url
 * segments separated by dots AND the first segment decodes to a JSON object
 * with `alg`, it is treated as a JWT. Otherwise it is treated as a raw
 * Chatwoot API key.
 *
 * Env:
 *   CHATWOOT_BASE_URL          — required. e.g. https://app.chatwoot.com
 *   CHATWOOT_API_KEY           — required for OAuth path. The single-tenant
 *                                Chatwoot API key mapped to every valid JWT.
 *   MCP_OAUTH_SIGNING_SECRET   — required to enable OAuth. Base64 or hex,
 *                                min 32 bytes. If absent, OAuth routes are not
 *                                mounted (backward-compat).
 *   MCP_OAUTH_ISSUER           — required to enable OAuth. Public base URL
 *                                of this server, used as JWT `iss` and in
 *                                discovery docs. e.g.
 *                                https://your-chatwoot.example.com
 *   MCP_PORT                   — default 3198
 *   MCP_HOST                   — default 127.0.0.1
 */

import "dotenv/config"
import * as http from "node:http"
import * as crypto from "node:crypto"
import createClient from "openapi-fetch"
import type { Middleware } from "openapi-fetch"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { clientStore, type ChatwootHttpClient } from "./services/client-context.js"
import { registerChatwootTools } from "./register-tools.js"
import type { paths } from "./chatwoot-types.js"
import { createOAuthProvider } from "./oauth.js"

// ── Env ────────────────────────────────────────────────────────────────────

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL
const PORT = Number(process.env.MCP_PORT ?? 3198)
const HOST = process.env.MCP_HOST ?? "127.0.0.1"
const MCP_OAUTH_ISSUER = process.env.MCP_OAUTH_ISSUER ?? ""

if (!CHATWOOT_BASE_URL) {
  console.error("ERROR: CHATWOOT_BASE_URL is required (e.g. https://app.chatwoot.com)")
  process.exit(1)
}

// ── OAuth setup (optional — only when both secrets are present) ────────────

let oauthProvider: ReturnType<typeof createOAuthProvider> | null = null
let envChatwootApiKey: string | null = null

function parseSecret(raw: string): Buffer | null {
  // Accept base64 (URL-safe or standard) or hex; min 32 bytes.
  // Try hex first (64+ hex chars), then base64.
  if (/^[0-9a-fA-F]{64,}$/.test(raw)) {
    return Buffer.from(raw, "hex")
  }
  try {
    const buf = Buffer.from(raw, "base64")
    if (buf.length >= 32) return buf
  } catch {
    // fall through
  }
  return null
}

const rawSecret = process.env.MCP_OAUTH_SIGNING_SECRET
const rawApiKey = process.env.CHATWOOT_API_KEY

if (!rawSecret) {
  console.warn("[oauth] MCP_OAUTH_SIGNING_SECRET not set — OAuth routes disabled. Static-Bearer auth still works.")
} else if (!rawApiKey) {
  console.warn("[oauth] CHATWOOT_API_KEY not set — OAuth routes disabled. Static-Bearer auth still works.")
} else {
  const secretBuf = parseSecret(rawSecret)
  if (!secretBuf) {
    console.warn("[oauth] MCP_OAUTH_SIGNING_SECRET must decode to ≥ 32 bytes (base64 or hex) — OAuth disabled.")
  } else {
    envChatwootApiKey = rawApiKey
    oauthProvider = createOAuthProvider({
      issuer: MCP_OAUTH_ISSUER,
      signingSecret: secretBuf,
      codeTtlSeconds: 300,
      tokenTtlSeconds: 86400,
    })
    console.log(`[oauth] OAuth 2.0 + PKCE enabled. Issuer: ${MCP_OAUTH_ISSUER}`)
  }
}

// ── JWT bearer detection ───────────────────────────────────────────────────

function looksLikeJWT(value: string): boolean {
  // A JWT has exactly three dot-separated base64url segments and starts with "eyJ"
  // (base64url for `{"` which every JWT header begins with).
  const parts = value.split(".")
  if (parts.length !== 3) return false
  return parts[0].startsWith("eyJ")
}

// ── Token extraction ───────────────────────────────────────────────────────

/**
 * Returns the Chatwoot API token to use for this request, or null if the
 * request is unauthenticated / carries an invalid token.
 *
 * Priority:
 *   1. JWT Bearer — verified by the OAuth provider; if valid, returns the
 *      env-baked CHATWOOT_API_KEY. If invalid JWT, returns null (→ 401).
 *   2. Raw Bearer / api-access-token header — forwarded as-is to Chatwoot
 *      (existing Desktop-config behavior, unchanged).
 *   3. No auth header — null (→ 401).
 */
function extractToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (auth && auth.startsWith("Bearer ")) {
    const value = auth.slice(7).trim()
    if (looksLikeJWT(value)) {
      // OAuth path: verify JWT locally, map to env key.
      if (!oauthProvider || !envChatwootApiKey) {
        // OAuth not configured; refuse JWT — do not leak env key to unverifiable tokens.
        return null
      }
      const claims = oauthProvider.verifyAccessToken(value)
      return claims !== null ? envChatwootApiKey : null
    }
    // Static-Bearer path: raw Chatwoot API key.
    return value !== "" ? value : null
  }

  // Chatwoot's own REST API header — accept it directly so users can paste
  // the token from Chatwoot Settings → Profile without re-wrapping.
  const direct = req.headers["api-access-token"] ?? req.headers["api_access_token"]
  if (typeof direct === "string" && direct !== "") return direct

  return null
}

// ── Chatwoot HTTP client factory ───────────────────────────────────────────

function clientForToken(apiToken: string): ChatwootHttpClient {
  const c = createClient<paths>({ baseUrl: CHATWOOT_BASE_URL! })
  const mw: Middleware = {
    async onRequest({ request }) {
      request.headers.set("api-access-token", apiToken)
      request.headers.set("Content-Type", "application/json")
      return request
    },
  }
  c.use(mw)
  return c
}

// ── 401 response ───────────────────────────────────────────────────────────

function sendUnauthorized(res: http.ServerResponse): void {
  // RFC 9728: include resource_metadata so MCP clients can discover the OAuth
  // server automatically (Claude web/mobile Custom Connector uses this).
  const protectedResourceUrl = `${MCP_OAUTH_ISSUER}/.well-known/oauth-protected-resource`
  const authServerUrl = `${MCP_OAUTH_ISSUER}/.well-known/oauth-authorization-server`

  const wwwAuth = oauthProvider
    ? `Bearer realm="chatwoot-mcp", resource_metadata="${protectedResourceUrl}", as_uri="${authServerUrl}"`
    : 'Bearer realm="chatwoot-mcp", error="invalid_token", ' +
      'error_description="Send your Chatwoot API access token as `Authorization: Bearer <token>` or `api-access-token: <token>`. ' +
      `Get one at ${MCP_OAUTH_ISSUER}/app/accounts/{your-account}/profile/settings"`

  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": wwwAuth,
  })
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Unauthorized: missing or invalid token.",
        data: oauthProvider
          ? {
              oauth_authorization_server: authServerUrl,
              help: "Connect via OAuth or pass a Chatwoot API token as `Authorization: Bearer <token>`.",
            }
          : {
              how_to_get_one:
                "Chatwoot → click your profile (top right) → Profile Settings → Access Token. Send it as `Authorization: Bearer <token>`.",
            },
      },
      id: null,
    })
  )
}

// ── Body reader ────────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8")
        resolve(raw === "" ? undefined : JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", reject)
  })
}

// ── MCP request handler ────────────────────────────────────────────────────

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = extractToken(req)
  if (!token) {
    sendUnauthorized(res)
    return
  }

  const client = clientForToken(token)

  const server = new McpServer({ name: "chatwoot-mcp-server", version: "1.0.0" })
  registerChatwootTools(server)

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)

  res.on("close", () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  })

  try {
    const body = await readBody(req)
    await clientStore.run(client, async () => {
      await transport.handleRequest(req, res, body)
    })
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error", data: String(err) },
          id: null,
        })
      )
    }
  }
}

// ── HTTP server ────────────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, api-access-token, mcp-session-id, mcp-protocol-version"
  )
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  // ── Health ──────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/mcp/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        ok: true,
        service: "chatwoot-mcp-server",
        version: "1.0.0",
        upstream: CHATWOOT_BASE_URL,
        oauth: oauthProvider !== null,
      })
    )
    return
  }

  // Keep legacy /health alias working too.
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        ok: true,
        service: "chatwoot-mcp-server",
        version: "1.0.0",
        upstream: CHATWOOT_BASE_URL,
        oauth: oauthProvider !== null,
      })
    )
    return
  }

  // ── OAuth routes (mounted only when provider is configured) ─────────────
  if (oauthProvider) {
    // RFC 8414 — Authorization Server Metadata
    if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
      oauthProvider.handleDiscovery(req, res, "authorization_server")
      return
    }

    // RFC 9728 — Protected Resource Metadata (bare + any suffix, e.g. /mcp)
    if (req.method === "GET" && req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      oauthProvider.handleDiscovery(req, res, "protected_resource")
      return
    }

    // DCR — POST /oauth/register
    if (req.method === "POST" && req.url === "/oauth/register") {
      await oauthProvider.handleRegister(req, res)
      return
    }

    // Authorization endpoint — GET /oauth/authorize
    if (req.method === "GET" && req.url?.startsWith("/oauth/authorize")) {
      oauthProvider.handleAuthorize(req, res)
      return
    }

    // Token endpoint — POST /oauth/token
    if (req.method === "POST" && req.url === "/oauth/token") {
      await oauthProvider.handleToken(req, res)
      return
    }
  }

  // ── MCP endpoint ─────────────────────────────────────────────────────────
  if (req.url === "/" || req.url?.startsWith("/mcp") || req.url?.startsWith("/sse")) {
    await handleMcp(req, res)
    return
  }

  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "not_found", message: `${req.method} ${req.url}` }))
})

httpServer.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`chatwoot-mcp listening on http://${HOST}:${PORT}`)
  // eslint-disable-next-line no-console
  console.log(`  upstream: ${CHATWOOT_BASE_URL}`)
  // eslint-disable-next-line no-console
  console.log(`  POST /mcp  — MCP protocol endpoint`)
  // eslint-disable-next-line no-console
  console.log(`  GET /mcp/health (also /health)  — liveness probe`)
  if (oauthProvider) {
    // eslint-disable-next-line no-console
    console.log(`  OAuth endpoints:`)
    // eslint-disable-next-line no-console
    console.log(`    GET  /.well-known/oauth-authorization-server`)
    // eslint-disable-next-line no-console
    console.log(`    GET  /.well-known/oauth-protected-resource`)
    // eslint-disable-next-line no-console
    console.log(`    POST /oauth/register`)
    // eslint-disable-next-line no-console
    console.log(`    GET  /oauth/authorize`)
    // eslint-disable-next-line no-console
    console.log(`    POST /oauth/token`)
  }
})

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} — shutting down`)
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

// Export for testing
export { extractToken as _extractToken, looksLikeJWT as _looksLikeJWT }
