/**
 * Test setup - loads environment variables
 */
import dotenv from "dotenv";

dotenv.config();

// Validate required env vars for tests
if (!process.env.CHATWOOT_BASE_URL || !process.env.CHATWOOT_API_TOKEN) {
  console.warn(
    "⚠️  Warning: CHATWOOT_BASE_URL and CHATWOOT_API_TOKEN must be set in .env for integration tests"
  );
}
