/**
 * Single-tenant OAuth 2.0 + PKCE + DCR provider for chatwoot-mcp.
 *
 * Design: ONE user (single-tenant). The /authorize endpoint auto-approves
 * immediately — no consent HTML, no login page. The issued access token is
 * a self-signed HS256 JWT that proves "this caller completed PKCE on our
 * server". The MCP layer maps any valid JWT back to the env-baked
 * CHATWOOT_API_KEY; the JWT itself carries no Chatwoot credential.
 *
 * Implements:
 *   RFC 8414 — Authorization Server Metadata
 *   RFC 9728 — Protected Resource Metadata
 *   RFC 7591 — Dynamic Client Registration (stateless, no storage)
 *   RFC 7636 — Proof Key for Code Exchange (S256 only)
 *   RFC 6749 — Authorization Code Grant
 *
 * Dependencies: Node built-ins only (node:crypto, node:http). No jose, no
 * jsonwebtoken.
 */

import * as http from "node:http"
import * as crypto from "node:crypto"

// ── Types ──────────────────────────────────────────────────────────────────

export interface OAuthConfig {
  /** e.g. "https://your-chatwoot.example.com" */
  issuer: string
  /** ≥ 32 bytes, used as HS256 HMAC key */
  signingSecret: Buffer
  /** seconds a one-time auth code lives — default 300 */
  codeTtlSeconds: number
  /** seconds until an access token expires — default 86400 */
  tokenTtlSeconds: number
}

interface PendingCode {
  codeChallenge: string
  redirectUri: string
  clientId: string
  expiresAt: number // unix seconds
}

interface VerifiedToken {
  sub: string
  scope: string
}

// ── HS256 JWT helpers (pure Node crypto, no external deps) ─────────────────

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function b64urlDecode(s: string): Buffer {
  // Re-pad and convert url-safe chars back
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
  const pad = (4 - (padded.length % 4)) % 4
  return Buffer.from(padded + "=".repeat(pad), "base64")
}

function signHS256(header64: string, payload64: string, secret: Buffer): string {
  return b64url(
    crypto.createHmac("sha256", secret).update(`${header64}.${payload64}`).digest()
  )
}

function issueJWT(
  claims: Record<string, unknown>,
  secret: Buffer
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = b64url(JSON.stringify(claims))
  const sig = signHS256(header, payload, secret)
  return `${header}.${payload}.${sig}`
}

function parseJWT(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; sig: Buffer; signingInput: string } | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(b64urlDecode(parts[0]).toString("utf8")) as Record<string, unknown>
    const payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8")) as Record<string, unknown>
    const sig = b64urlDecode(parts[2])
    return { header, payload, sig, signingInput: `${parts[0]}.${parts[1]}` }
  } catch {
    return null
  }
}

// ── PKCE helper ────────────────────────────────────────────────────────────

function verifyS256(verifier: string, challenge: string): boolean {
  const expected = b64url(crypto.createHash("sha256").update(verifier, "ascii").digest())
  try {
    const a = Buffer.from(expected, "ascii")
    const b = Buffer.from(challenge, "ascii")
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(json)
}

function sendOAuthError(
  res: http.ServerResponse,
  status: number,
  error: string,
  description: string
): void {
  sendJSON(res, status, { error, error_description: description })
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createOAuthProvider(cfg: OAuthConfig) {
  const { issuer, signingSecret, codeTtlSeconds, tokenTtlSeconds } = cfg

  // In-memory store: code → metadata. No DB, restarts invalidate codes (fine
  // given the 5-minute TTL).
  const pendingCodes = new Map<string, PendingCode>()

  // Sweep stale codes lazily when a new one is created (no timer needed).
  function sweepExpiredCodes(): void {
    const now = Math.floor(Date.now() / 1000)
    for (const [code, meta] of pendingCodes) {
      if (meta.expiresAt < now) pendingCodes.delete(code)
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  function handleDiscovery(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    kind: "authorization_server" | "protected_resource"
  ): void {
    if (kind === "authorization_server") {
      sendJSON(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        scopes_supported: ["read", "write"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        service_documentation: "https://github.com/hugoblanc/chatwoot-mcp",
      })
    } else {
      sendJSON(res, 200, {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ["read", "write"],
        bearer_methods_supported: ["header"],
      })
    }
  }

  // ── DCR — RFC 7591 ───────────────────────────────────────────────────────

  async function handleRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let body: Record<string, unknown> = {}
    try {
      const raw = await readRawBody(req)
      if (raw.trim() !== "") body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      sendOAuthError(res, 400, "invalid_request", "Malformed JSON body")
      return
    }

    // Stateless: generate a random client_id and echo back acceptable metadata.
    const clientId = `cw_${crypto.randomBytes(8).toString("hex")}`
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []

    sendJSON(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      // Echo back any provided metadata fields
      ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
      ...(typeof body.client_uri === "string" ? { client_uri: body.client_uri } : {}),
      ...(Array.isArray(body.scope)
        ? { scope: (body.scope as string[]).join(" ") }
        : typeof body.scope === "string"
          ? { scope: body.scope }
          : { scope: "read write" }),
    })
  }

  // ── Authorize — RFC 7636 ─────────────────────────────────────────────────

  function handleAuthorize(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const rawUrl = req.url ?? ""
    const queryStart = rawUrl.indexOf("?")
    const qs = queryStart >= 0 ? rawUrl.slice(queryStart + 1) : ""
    const params = new URLSearchParams(qs)

    const responseType = params.get("response_type")
    const clientId = params.get("client_id")
    const redirectUri = params.get("redirect_uri")
    const codeChallenge = params.get("code_challenge")
    const codeChallengeMethod = params.get("code_challenge_method")
    const state = params.get("state") ?? ""

    // Helper: redirect with error (if redirectUri known) or return 400 JSON.
    function rejectWithError(err: string, description: string): void {
      if (redirectUri) {
        const dest = new URL(redirectUri)
        dest.searchParams.set("error", err)
        dest.searchParams.set("error_description", description)
        if (state) dest.searchParams.set("state", state)
        res.writeHead(302, { Location: dest.toString() })
        res.end()
      } else {
        sendOAuthError(res, 400, err, description)
      }
    }

    if (responseType !== "code") {
      return rejectWithError("unsupported_response_type", "Only response_type=code is supported")
    }
    if (!clientId) {
      return rejectWithError("invalid_request", "Missing client_id")
    }
    if (!redirectUri) {
      sendOAuthError(res, 400, "invalid_request", "Missing redirect_uri")
      return
    }
    if (!codeChallenge) {
      return rejectWithError("invalid_request", "Missing code_challenge (PKCE required)")
    }
    if (codeChallengeMethod !== "S256") {
      return rejectWithError("invalid_request", "Only code_challenge_method=S256 is supported")
    }

    // Validate redirect_uri is a parseable URL.
    try {
      new URL(redirectUri)
    } catch {
      sendOAuthError(res, 400, "invalid_request", "redirect_uri is not a valid URL")
      return
    }

    sweepExpiredCodes()

    const code = crypto.randomBytes(32).toString("base64url")
    const now = Math.floor(Date.now() / 1000)
    pendingCodes.set(code, {
      codeChallenge,
      redirectUri,
      clientId,
      expiresAt: now + codeTtlSeconds,
    })

    const dest = new URL(redirectUri)
    dest.searchParams.set("code", code)
    if (state) dest.searchParams.set("state", state)

    res.writeHead(302, { Location: dest.toString() })
    res.end()
  }

  // ── Token — RFC 6749 + RFC 7636 ──────────────────────────────────────────

  async function handleToken(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let raw: string
    try {
      raw = await readRawBody(req)
    } catch {
      sendOAuthError(res, 400, "invalid_request", "Could not read request body")
      return
    }

    const params = new URLSearchParams(raw)
    const grantType = params.get("grant_type")
    const code = params.get("code")
    const redirectUri = params.get("redirect_uri")
    const clientId = params.get("client_id")
    const codeVerifier = params.get("code_verifier")

    if (grantType !== "authorization_code") {
      sendOAuthError(res, 400, "unsupported_grant_type", "Only authorization_code grant is supported")
      return
    }
    if (!code) {
      sendOAuthError(res, 400, "invalid_request", "Missing code")
      return
    }
    if (!redirectUri) {
      sendOAuthError(res, 400, "invalid_request", "Missing redirect_uri")
      return
    }
    if (!clientId) {
      sendOAuthError(res, 400, "invalid_request", "Missing client_id")
      return
    }
    if (!codeVerifier) {
      sendOAuthError(res, 400, "invalid_request", "Missing code_verifier (PKCE required)")
      return
    }

    const pending = pendingCodes.get(code)
    const now = Math.floor(Date.now() / 1000)

    if (!pending || pending.expiresAt < now) {
      sendOAuthError(res, 400, "invalid_grant", "Authorization code not found or expired")
      return
    }

    if (pending.redirectUri !== redirectUri) {
      sendOAuthError(res, 400, "invalid_grant", "redirect_uri mismatch")
      return
    }

    if (pending.clientId !== clientId) {
      sendOAuthError(res, 400, "invalid_grant", "client_id mismatch")
      return
    }

    if (!verifyS256(codeVerifier, pending.codeChallenge)) {
      sendOAuthError(res, 400, "invalid_grant", "code_verifier does not match code_challenge")
      return
    }

    // One-shot: delete immediately after consumption.
    pendingCodes.delete(code)

    const iat = now
    const exp = now + tokenTtlSeconds
    const accessToken = issueJWT(
      {
        iss: issuer,
        sub: "single-tenant",
        aud: `${issuer}/mcp`,
        iat,
        exp,
        scope: "read write",
      },
      signingSecret
    )

    sendJSON(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: tokenTtlSeconds,
      scope: "read write",
    })
  }

  // ── Token verification ────────────────────────────────────────────────────

  function verifyAccessToken(token: string): VerifiedToken | null {
    const parsed = parseJWT(token)
    if (!parsed) return null

    const { header, payload, sig, signingInput } = parsed

    if (header.alg !== "HS256") return null

    // Recompute expected signature and constant-time compare.
    const expectedSig = b64urlDecode(
      signHS256(
        signingInput.split(".")[0],
        signingInput.split(".")[1],
        signingSecret
      )
    )
    if (sig.length !== expectedSig.length) return null
    try {
      if (!crypto.timingSafeEqual(sig, expectedSig)) return null
    } catch {
      return null
    }

    const now = Math.floor(Date.now() / 1000)
    const exp = typeof payload.exp === "number" ? payload.exp : 0
    const payloadIss = typeof payload.iss === "string" ? payload.iss : ""
    const payloadAud = payload.aud

    if (exp <= now) return null
    if (payloadIss !== issuer) return null

    // aud may be a string or an array per JWT spec.
    const expectedAud = `${issuer}/mcp`
    if (Array.isArray(payloadAud)) {
      if (!payloadAud.includes(expectedAud)) return null
    } else {
      if (payloadAud !== expectedAud) return null
    }

    const sub = typeof payload.sub === "string" ? payload.sub : "single-tenant"
    const scope = typeof payload.scope === "string" ? payload.scope : ""

    return { sub, scope }
  }

  return {
    handleDiscovery,
    handleRegister,
    handleAuthorize,
    handleToken,
    verifyAccessToken,
  }
}
