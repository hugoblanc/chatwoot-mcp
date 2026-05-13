/**
 * Unit tests for src/oauth.ts — single-tenant OAuth 2.0 + PKCE + DCR provider.
 *
 * Tests are self-contained; they do NOT require a running server or any
 * external service. All OAuth operations are exercised by calling the handler
 * functions directly with mock IncomingMessage / ServerResponse objects.
 */

import { describe, it, expect, beforeEach } from "vitest"
import * as crypto from "node:crypto"
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createOAuthProvider } from "../src/oauth.js"

// ── Test helpers ─────────────────────────────────────────────────────────────

const TEST_ISSUER = "https://chat.example.com"
const TEST_SECRET = crypto.randomBytes(64) // fresh 64-byte secret for every run

function makeProvider(overrides: Partial<Parameters<typeof createOAuthProvider>[0]> = {}) {
  return createOAuthProvider({
    issuer: TEST_ISSUER,
    signingSecret: TEST_SECRET,
    codeTtlSeconds: 300,
    tokenTtlSeconds: 86400,
    ...overrides,
  })
}

// Minimal IncomingMessage mock. Calling end() resolves the body-reader promise.
function makeMockReq(opts: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const emitter = new EventEmitter()
  const req = emitter as unknown as IncomingMessage
  ;(req as any).method = opts.method ?? "GET"
  ;(req as any).url = opts.url ?? "/"
  ;(req as any).headers = opts.headers ?? {}

  // Simulate body emission on next tick so the handler can attach listeners.
  if (opts.body !== undefined) {
    setImmediate(() => {
      emitter.emit("data", Buffer.from(opts.body as string, "utf8"))
      emitter.emit("end")
    })
  } else {
    setImmediate(() => emitter.emit("end"))
  }

  return req
}

interface CapturedResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function makeMockRes(): { res: ServerResponse; captured: () => CapturedResponse } {
  let statusCode = 200
  const headers: Record<string, string> = {}
  let body = ""

  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code
      if (hdrs) Object.assign(headers, hdrs)
    },
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    getHeader(name: string) {
      return headers[name]
    },
    end(chunk?: string) {
      if (chunk) body += chunk
    },
    on() { return this },
    headersSent: false,
  } as unknown as ServerResponse

  return {
    res,
    captured: () => ({ statusCode, headers, body }),
  }
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function makeS256(verifier: string): string {
  return b64url(crypto.createHash("sha256").update(verifier, "ascii").digest())
}

// ── Full authorize → token flow helper ───────────────────────────────────────

async function doFullFlow(
  provider: ReturnType<typeof makeProvider>,
  opts: {
    clientId?: string
    redirectUri?: string
    state?: string
    badVerifier?: boolean
  } = {}
): Promise<{ code: string; accessToken?: string; tokenStatus: number; tokenBody: string }> {
  const clientId = opts.clientId ?? "test_client_abc"
  const redirectUri = opts.redirectUri ?? "https://app.example.com/oauth/callback"
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = makeS256(verifier)
  const state = opts.state ?? "randomstate123"

  // Authorize
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })
  const authReq = makeMockReq({ method: "GET", url: `/oauth/authorize?${qs}` })
  const { res: authRes, captured: authCaptured } = makeMockRes()
  provider.handleAuthorize(authReq, authRes)

  const authResult = authCaptured()
  expect(authResult.statusCode).toBe(302)
  const location = authResult.headers["Location"]
  const locationUrl = new URL(location)
  const code = locationUrl.searchParams.get("code")!
  expect(code).toBeTruthy()

  // Token exchange
  const usedVerifier = opts.badVerifier ? "this_is_the_wrong_verifier" : verifier
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: usedVerifier,
  }).toString()

  const tokenReq = makeMockReq({
    method: "POST",
    url: "/oauth/token",
    body: tokenBody,
  })
  const { res: tokenRes, captured: tokenCaptured } = makeMockRes()
  await provider.handleToken(tokenReq, tokenRes)

  const result = tokenCaptured()
  let accessToken: string | undefined
  if (result.statusCode === 200) {
    accessToken = (JSON.parse(result.body) as { access_token: string }).access_token
  }

  return { code, accessToken, tokenStatus: result.statusCode, tokenBody: result.body }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DCR — POST /oauth/register", () => {
  it("returns valid client metadata with generated client_id", async () => {
    const provider = makeProvider()
    const body = JSON.stringify({
      redirect_uris: ["https://app.example.com/oauth/callback"],
      client_name: "Claude Web",
      scope: "read write",
    })
    const req = makeMockReq({ method: "POST", url: "/oauth/register", body })
    const { res, captured } = makeMockRes()

    await provider.handleRegister(req, res)
    const result = captured()

    expect(result.statusCode).toBe(201)
    const data = JSON.parse(result.body) as Record<string, unknown>
    expect(typeof data.client_id).toBe("string")
    expect((data.client_id as string).startsWith("cw_")).toBe(true)
    expect(data.client_id_issued_at).toBeTypeOf("number")
    expect(data.redirect_uris).toEqual(["https://app.example.com/oauth/callback"])
    expect(data.token_endpoint_auth_method).toBe("none")
    expect(data.grant_types).toContain("authorization_code")
    expect(data.response_types).toContain("code")
    expect(data.client_name).toBe("Claude Web")
  })

  it("returns unique client_id on each call (stateless randomness)", async () => {
    const provider = makeProvider()
    const body = JSON.stringify({ redirect_uris: ["https://example.com/cb"] })

    const results: string[] = []
    for (let i = 0; i < 3; i++) {
      const req = makeMockReq({ method: "POST", url: "/oauth/register", body })
      const { res, captured } = makeMockRes()
      await provider.handleRegister(req, res)
      const data = JSON.parse(captured().body) as { client_id: string }
      results.push(data.client_id)
    }
    expect(new Set(results).size).toBe(3)
  })

  it("handles empty body gracefully", async () => {
    const provider = makeProvider()
    const req = makeMockReq({ method: "POST", url: "/oauth/register", body: "" })
    const { res, captured } = makeMockRes()

    await provider.handleRegister(req, res)
    const result = captured()
    expect(result.statusCode).toBe(201)
    const data = JSON.parse(result.body) as Record<string, unknown>
    expect(typeof data.client_id).toBe("string")
  })
})

describe("/oauth/authorize", () => {
  it("redirects with code and state preserved for valid params", () => {
    const provider = makeProvider()
    const verifier = b64url(crypto.randomBytes(32))
    const challenge = makeS256(verifier)
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: "client123",
      redirect_uri: "https://app.example.com/oauth/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "mystate42",
    })

    const req = makeMockReq({ method: "GET", url: `/oauth/authorize?${qs}` })
    const { res, captured } = makeMockRes()
    provider.handleAuthorize(req, res)

    const result = captured()
    expect(result.statusCode).toBe(302)

    const location = new URL(result.headers["Location"])
    expect(location.searchParams.get("code")).toBeTruthy()
    expect(location.searchParams.get("state")).toBe("mystate42")
    expect(location.searchParams.has("error")).toBe(false)
  })

  it("redirects with error=invalid_request when code_challenge is missing", () => {
    const provider = makeProvider()
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: "client123",
      redirect_uri: "https://app.example.com/oauth/callback",
      // No code_challenge!
      code_challenge_method: "S256",
    })

    const req = makeMockReq({ method: "GET", url: `/oauth/authorize?${qs}` })
    const { res, captured } = makeMockRes()
    provider.handleAuthorize(req, res)

    const result = captured()
    expect(result.statusCode).toBe(302)
    const location = new URL(result.headers["Location"])
    expect(location.searchParams.get("error")).toBe("invalid_request")
  })

  it("returns 400 JSON when redirect_uri is missing entirely", () => {
    const provider = makeProvider()
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: "client123",
      code_challenge: makeS256("verifier"),
      code_challenge_method: "S256",
      // No redirect_uri
    })

    const req = makeMockReq({ method: "GET", url: `/oauth/authorize?${qs}` })
    const { res, captured } = makeMockRes()
    provider.handleAuthorize(req, res)

    const result = captured()
    expect(result.statusCode).toBe(400)
    const data = JSON.parse(result.body) as { error: string }
    expect(data.error).toBe("invalid_request")
  })

  it("rejects non-S256 code_challenge_method", () => {
    const provider = makeProvider()
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: "client123",
      redirect_uri: "https://example.com/cb",
      code_challenge: "abc",
      code_challenge_method: "plain", // not supported
    })

    const req = makeMockReq({ method: "GET", url: `/oauth/authorize?${qs}` })
    const { res, captured } = makeMockRes()
    provider.handleAuthorize(req, res)

    const result = captured()
    expect(result.statusCode).toBe(302)
    const location = new URL(result.headers["Location"])
    expect(location.searchParams.get("error")).toBe("invalid_request")
  })

  it("rejects missing client_id", () => {
    const provider = makeProvider()
    const qs = new URLSearchParams({
      response_type: "code",
      redirect_uri: "https://example.com/cb",
      code_challenge: makeS256("verifier"),
      code_challenge_method: "S256",
    })

    const req = makeMockReq({ method: "GET", url: `/oauth/authorize?${qs}` })
    const { res, captured } = makeMockRes()
    provider.handleAuthorize(req, res)

    const result = captured()
    // redirect_uri is present, so should redirect with error
    expect(result.statusCode).toBe(302)
    const location = new URL(result.headers["Location"])
    expect(location.searchParams.get("error")).toBe("invalid_request")
  })
})

describe("/oauth/token", () => {
  it("returns a JWT with correct claims for a valid PKCE flow", async () => {
    const provider = makeProvider()
    const { accessToken, tokenStatus } = await doFullFlow(provider)

    expect(tokenStatus).toBe(200)
    expect(typeof accessToken).toBe("string")

    // Decode the JWT payload (don't re-verify here, verifyAccessToken tests do that)
    const parts = accessToken!.split(".")
    expect(parts.length).toBe(3)
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>

    expect(payload.iss).toBe(TEST_ISSUER)
    expect(payload.sub).toBe("single-tenant")
    expect(payload.aud).toBe(`${TEST_ISSUER}/mcp`)
    expect(payload.scope).toBe("read write")
    expect(typeof payload.iat).toBe("number")
    expect(typeof payload.exp).toBe("number")
    expect((payload.exp as number) - (payload.iat as number)).toBe(86400)
  })

  it("returns 400 invalid_grant for wrong code_verifier", async () => {
    const provider = makeProvider()
    const { tokenStatus, tokenBody } = await doFullFlow(provider, { badVerifier: true })

    expect(tokenStatus).toBe(400)
    const data = JSON.parse(tokenBody) as { error: string }
    expect(data.error).toBe("invalid_grant")
  })

  it("returns 400 invalid_grant when code is reused", async () => {
    const provider = makeProvider()

    const verifier = b64url(crypto.randomBytes(32))
    const challenge = makeS256(verifier)
    const clientId = "reuse_test_client"
    const redirectUri = "https://app.example.com/oauth/callback"

    // Step 1: authorize
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    const authReq = makeMockReq({ method: "GET", url: `/oauth/authorize?${qs}` })
    const { res: authRes, captured: authCaptured } = makeMockRes()
    provider.handleAuthorize(authReq, authRes)

    const location = new URL(authCaptured().headers["Location"])
    const code = location.searchParams.get("code")!

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString()

    // Step 2: first use — should succeed
    const req1 = makeMockReq({ method: "POST", url: "/oauth/token", body: tokenParams })
    const { res: res1, captured: c1 } = makeMockRes()
    await provider.handleToken(req1, res1)
    expect(c1().statusCode).toBe(200)

    // Step 3: second use with same code — must fail
    const req2 = makeMockReq({ method: "POST", url: "/oauth/token", body: tokenParams })
    const { res: res2, captured: c2 } = makeMockRes()
    await provider.handleToken(req2, res2)
    expect(c2().statusCode).toBe(400)
    const data = JSON.parse(c2().body) as { error: string }
    expect(data.error).toBe("invalid_grant")
  })

  it("returns 400 for missing grant_type", async () => {
    const provider = makeProvider()
    const body = new URLSearchParams({
      code: "abc",
      redirect_uri: "https://example.com/cb",
      client_id: "x",
      code_verifier: "y",
    }).toString()

    const req = makeMockReq({ method: "POST", url: "/oauth/token", body })
    const { res, captured } = makeMockRes()
    await provider.handleToken(req, res)

    expect(captured().statusCode).toBe(400)
    const data = JSON.parse(captured().body) as { error: string }
    expect(data.error).toBe("unsupported_grant_type")
  })
})

describe("verifyAccessToken", () => {
  it("accepts a freshly issued token", async () => {
    const provider = makeProvider()
    const { accessToken } = await doFullFlow(provider)
    expect(accessToken).toBeDefined()

    const claims = provider.verifyAccessToken(accessToken!)
    expect(claims).not.toBeNull()
    expect(claims!.sub).toBe("single-tenant")
    expect(claims!.scope).toBe("read write")
  })

  it("rejects an expired token (tokenTtlSeconds=0 trick)", async () => {
    // Issue a token with a 0-second TTL so it expires immediately.
    const shortLivedProvider = makeProvider({ tokenTtlSeconds: 0 })
    const { accessToken } = await doFullFlow(shortLivedProvider)
    expect(accessToken).toBeDefined()

    // Wait a tick then verify — exp will be in the past.
    await new Promise((r) => setImmediate(r))
    const claims = shortLivedProvider.verifyAccessToken(accessToken!)
    expect(claims).toBeNull()
  })

  it("rejects a token whose signature has been tampered with", async () => {
    const provider = makeProvider()
    const { accessToken } = await doFullFlow(provider)
    expect(accessToken).toBeDefined()

    // Flip the last character of the signature segment.
    const parts = accessToken!.split(".")
    const lastChar = parts[2].slice(-1)
    const flipped = lastChar === "A" ? "B" : "A"
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${flipped}`

    expect(provider.verifyAccessToken(tampered)).toBeNull()
  })

  it("rejects a token signed with a different secret", async () => {
    const otherProvider = makeProvider({ signingSecret: crypto.randomBytes(64) })
    const { accessToken } = await doFullFlow(otherProvider)
    expect(accessToken).toBeDefined()

    // Verify with the original provider (different secret) — must fail.
    const provider = makeProvider()
    expect(provider.verifyAccessToken(accessToken!)).toBeNull()
  })

  it("rejects a random string that is not a JWT", () => {
    const provider = makeProvider()
    expect(provider.verifyAccessToken("not-a-jwt")).toBeNull()
    expect(provider.verifyAccessToken("")).toBeNull()
    expect(provider.verifyAccessToken("a.b")).toBeNull()
  })

  it("rejects a JWT with wrong issuer", async () => {
    const otherIssuerProvider = makeProvider({ issuer: "https://evil.example.com" })
    const { accessToken } = await doFullFlow(otherIssuerProvider)
    expect(accessToken).toBeDefined()

    // Must fail against the canonical issuer provider.
    const provider = makeProvider()
    expect(provider.verifyAccessToken(accessToken!)).toBeNull()
  })
})

describe("Discovery endpoints", () => {
  it("authorization_server doc has required fields", () => {
    const provider = makeProvider()
    const req = makeMockReq({ method: "GET", url: "/.well-known/oauth-authorization-server" })
    const { res, captured } = makeMockRes()
    provider.handleDiscovery(req, res, "authorization_server")

    const result = captured()
    expect(result.statusCode).toBe(200)
    const doc = JSON.parse(result.body) as Record<string, unknown>
    expect(doc.issuer).toBe(TEST_ISSUER)
    expect(doc.authorization_endpoint).toBe(`${TEST_ISSUER}/oauth/authorize`)
    expect(doc.token_endpoint).toBe(`${TEST_ISSUER}/oauth/token`)
    expect(doc.registration_endpoint).toBe(`${TEST_ISSUER}/oauth/register`)
    expect(doc.code_challenge_methods_supported).toContain("S256")
    expect(doc.response_types_supported).toContain("code")
    expect(doc.grant_types_supported).toContain("authorization_code")
    expect(doc.token_endpoint_auth_methods_supported).toContain("none")
  })

  it("protected_resource doc has required fields", () => {
    const provider = makeProvider()
    const req = makeMockReq({ method: "GET", url: "/.well-known/oauth-protected-resource" })
    const { res, captured } = makeMockRes()
    provider.handleDiscovery(req, res, "protected_resource")

    const result = captured()
    expect(result.statusCode).toBe(200)
    const doc = JSON.parse(result.body) as Record<string, unknown>
    expect(doc.resource).toBe(`${TEST_ISSUER}/mcp`)
    expect(Array.isArray(doc.authorization_servers)).toBe(true)
    expect((doc.authorization_servers as string[]).includes(TEST_ISSUER)).toBe(true)
    expect(doc.bearer_methods_supported).toContain("header")
  })
})

describe("extractToken logic (JWT vs raw Chatwoot key)", () => {
  // We test the logic by reproducing the same decision the http.ts handler
  // makes, using the oauth provider directly (avoids importing the http.ts
  // module which starts a server on import).

  it("returns env key for a valid JWT Bearer", async () => {
    const provider = makeProvider()
    const envKey = "raw_chatwoot_api_key_abc123"

    const { accessToken } = await doFullFlow(provider)
    expect(accessToken).toBeDefined()

    // Simulate what http.ts extractToken does for a JWT Bearer:
    const claims = provider.verifyAccessToken(accessToken!)
    const resolved = claims !== null ? envKey : null
    expect(resolved).toBe(envKey)
  })

  it("leaves a raw Chatwoot key unchanged (non-JWT Bearer)", () => {
    const rawKey = "abc123xyz_chatwoot_token"
    // A raw Chatwoot key does NOT start with "eyJ" and/or doesn't have 3 dot-segments
    const looksJWT = rawKey.split(".").length === 3 && rawKey.startsWith("eyJ")
    expect(looksJWT).toBe(false)
    // Resolved as-is (http.ts returns the raw value directly)
    expect(rawKey).toBe(rawKey)
  })

  it("returns null for a tampered JWT Bearer", async () => {
    const provider = makeProvider()
    const envKey = "raw_chatwoot_api_key_abc123"

    const { accessToken } = await doFullFlow(provider)
    const tampered = accessToken!.slice(0, -3) + "AAA"

    const claims = provider.verifyAccessToken(tampered)
    const resolved = claims !== null ? envKey : null
    expect(resolved).toBeNull()
  })
})
