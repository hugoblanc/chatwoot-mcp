/**
 * Token cache to avoid storing passwords
 * Stores JWT tokens in a local file
 */

import fs from "fs/promises";
import path from "path";
import { homedir } from "os";
import type { ChatwootAuthTokens } from "./chatwoot-auth.js";

const CACHE_DIR = path.join(homedir(), ".chatwoot-mcp");
const CACHE_FILE = path.join(CACHE_DIR, "tokens.json");

interface CachedTokens {
  baseUrl: string;
  email: string;
  tokens: ChatwootAuthTokens;
}

/**
 * Save tokens to cache
 */
export async function saveTokens(
  baseUrl: string,
  email: string,
  tokens: ChatwootAuthTokens
): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });

    const cached: CachedTokens = { baseUrl, email, tokens };
    await fs.writeFile(CACHE_FILE, JSON.stringify(cached, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save tokens to cache:", error);
  }
}

/**
 * Load tokens from cache
 */
export async function loadTokens(
  baseUrl: string,
  email: string
): Promise<ChatwootAuthTokens | null> {
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    const cached: CachedTokens = JSON.parse(data);

    // Check if tokens match current config
    if (cached.baseUrl !== baseUrl || cached.email !== email) {
      return null;
    }

    // Check if tokens are expired
    const expiryTimestamp = parseInt(cached.tokens.expiry, 10);
    const now = Math.floor(Date.now() / 1000);

    if (expiryTimestamp <= now) {
      return null; // Expired
    }

    return cached.tokens;
  } catch (error) {
    // Cache doesn't exist or is invalid
    return null;
  }
}

/**
 * Clear token cache
 */
export async function clearTokens(): Promise<void> {
  try {
    await fs.unlink(CACHE_FILE);
  } catch (error) {
    // Ignore if file doesn't exist
  }
}
