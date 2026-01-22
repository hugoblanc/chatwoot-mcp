/**
 * Chatwoot API Client
 *
 * Supports both JWT (email/password) and API token authentication.
 * JWT tokens are cached to avoid re-authentication on every request.
 */

import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "../chatwoot-types.js";
import {
  loginToChatwoot,
  areTokensValid,
  type ChatwootAuthTokens,
  type ChatwootLoginCredentials,
} from "./chatwoot-auth.js";
import { loadTokens, saveTokens } from "./token-cache.js";

export interface ChatwootClientConfig {
  /** Base URL of your Chatwoot instance */
  baseUrl: string;

  /** Method 1: API Access Token (recommended if available) */
  apiAccessToken?: string;

  /** Method 2: JWT Authentication (fallback) */
  email?: string;
  password?: string;
}

/**
 * Creates a configured Chatwoot API client.
 * Tries API token first, falls back to JWT authentication.
 */
export async function createChatwootClient(config: ChatwootClientConfig) {
  const client = createClient<paths>({
    baseUrl: config.baseUrl,
  });

  // Method 1: API Access Token (simple, no expiration handling needed)
  if (config.apiAccessToken) {
    console.error("Using API access token authentication");

    const authMiddleware: Middleware = {
      async onRequest({ request }) {
        request.headers.set("api_access_token", config.apiAccessToken!);
        request.headers.set("Content-Type", "application/json");
        return request;
      },
    };

    client.use(authMiddleware);
    return client;
  }

  // Method 2: JWT Authentication (requires email/password)
  if (!config.email) {
    throw new Error(
      "Either apiAccessToken or email must be provided for authentication"
    );
  }

  let tokens: ChatwootAuthTokens | null = null;

  // Try to load tokens from cache first
  tokens = await loadTokens(config.baseUrl, config.email);

  // If no valid cached tokens, login with password
  if (!tokens) {
    if (!config.password) {
      throw new Error(
        "No cached JWT tokens found and no password provided. " +
        "Please provide CHATWOOT_PASSWORD for initial login, or use CHATWOOT_API_TOKEN instead."
      );
    }

    console.error("No cached JWT tokens, logging in...");
    tokens = await loginToChatwoot(config.baseUrl, {
      email: config.email,
      password: config.password,
    });

    await saveTokens(config.baseUrl, config.email, tokens);
    console.error(
      "JWT tokens cached successfully. " +
      "Consider using CHATWOOT_API_TOKEN to avoid token expiration issues."
    );
  }

  // Add JWT authentication middleware
  const authMiddleware: Middleware = {
    async onRequest({ request }) {
      // Check if tokens are still valid
      if (!areTokensValid(tokens!)) {
        if (!config.password) {
          throw new Error(
            "JWT tokens expired and no password provided for re-authentication. " +
            "Please use CHATWOOT_API_TOKEN instead, or provide CHATWOOT_PASSWORD."
          );
        }

        console.error("JWT tokens expired, re-authenticating...");
        tokens = await loginToChatwoot(config.baseUrl, {
          email: config.email!,
          password: config.password,
        });

        await saveTokens(config.baseUrl, config.email!, tokens);
      }

      // Add JWT headers
      request.headers.set("uid", tokens!.uid);
      request.headers.set("client", tokens!.client);
      request.headers.set("access-token", tokens!.accessToken);
      request.headers.set("expiry", tokens!.expiry);
      request.headers.set("token-type", "Bearer");
      request.headers.set("Content-Type", "application/json");

      return request;
    },
  };

  client.use(authMiddleware);
  return client;
}

/**
 * Global client instance
 */
let clientInstance: ReturnType<typeof createClient<paths>> | null = null;

export async function initializeClient(config: ChatwootClientConfig) {
  clientInstance = await createChatwootClient(config);
}

export function getClient(): ReturnType<typeof createClient<paths>> {
  if (!clientInstance) {
    throw new Error(
      "Chatwoot client not initialized. Call initializeClient() first."
    );
  }
  return clientInstance;
}
