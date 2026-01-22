/**
 * Chatwoot JWT Authentication
 *
 * Chatwoot uses devise_token_auth which requires:
 * - uid (email)
 * - client
 * - access-token
 * - expiry
 */

export interface ChatwootAuthTokens {
  uid: string;
  client: string;
  accessToken: string;
  expiry: string;
}

export interface ChatwootLoginCredentials {
  email: string;
  password: string;
}

/**
 * Login to Chatwoot and get JWT tokens
 */
export async function loginToChatwoot(
  baseUrl: string,
  credentials: ChatwootLoginCredentials
): Promise<ChatwootAuthTokens> {
  const response = await fetch(`${baseUrl}/auth/sign_in`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${response.status} ${error}`);
  }

  // Extract tokens from response headers
  const uid = response.headers.get("uid");
  const client = response.headers.get("client");
  const accessToken = response.headers.get("access-token");
  const expiry = response.headers.get("expiry");

  if (!uid || !client || !accessToken || !expiry) {
    throw new Error("Missing authentication tokens in response headers");
  }

  return {
    uid,
    client,
    accessToken,
    expiry,
  };
}

/**
 * Check if tokens are still valid
 */
export function areTokensValid(tokens: ChatwootAuthTokens): boolean {
  const expiryTimestamp = parseInt(tokens.expiry, 10);
  const now = Math.floor(Date.now() / 1000);
  return expiryTimestamp > now;
}
