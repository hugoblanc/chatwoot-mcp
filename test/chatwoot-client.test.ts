/**
 * Integration tests for Chatwoot API client
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createChatwootClient } from "../src/services/chatwoot-client.js";

describe("Chatwoot Client - API Token Authentication", () => {
  const baseUrl = process.env.CHATWOOT_BASE_URL!;
  const apiToken = process.env.CHATWOOT_API_TOKEN!;

  beforeAll(() => {
    if (!baseUrl || !apiToken) {
      throw new Error(
        "CHATWOOT_BASE_URL and CHATWOOT_API_TOKEN must be set in .env"
      );
    }
  });

  it("should create a client instance with API token", async () => {
    const client = await createChatwootClient({
      baseUrl,
      apiAccessToken: apiToken,
    });

    expect(client).toBeDefined();
    expect(typeof client.GET).toBe("function");
    expect(typeof client.POST).toBe("function");
  });

  it("should authenticate and list conversations", async () => {
    const client = await createChatwootClient({
      baseUrl,
      apiAccessToken: apiToken,
    });

    // Use account 3 as seen in the curl example
    const { data, error, response } = await client.GET(
      "/api/v1/accounts/{account_id}/conversations",
      {
        params: {
          path: { account_id: 3 },
          query: { status: "open" } as any,
        },
      }
    );

    console.log("Conversations response status:", response.status);

    if (error) {
      console.log("Error:", error);
      console.log("Response:", data);
    }

    expect(response.status).toBe(200);
    expect(error).toBeUndefined();
    expect(data).toBeDefined();

    const result = data as any;
    expect(result).toHaveProperty("data");
    expect(result.data).toHaveProperty("payload");

    console.log("Conversations found:", result.data.payload.length);
  });

  it("should fail with invalid API token", async () => {
    const client = await createChatwootClient({
      baseUrl,
      apiAccessToken: "invalid_token_12345",
    });

    const { error, response } = await client.GET(
      "/api/v1/accounts/{account_id}/conversations",
      {
        params: {
          path: { account_id: 3 },
          query: { status: "open" } as any,
        },
      }
    );

    expect(response.status).toBe(401);
    expect(error).toBeDefined();
  });

  it("should handle invalid account ID", async () => {
    const client = await createChatwootClient({
      baseUrl,
      apiAccessToken: apiToken,
    });

    const { error, response } = await client.GET(
      "/api/v1/accounts/{account_id}/conversations",
      {
        params: {
          path: { account_id: 999999 },
          query: { status: "open" } as any,
        },
      }
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(error).toBeDefined();
  });
});
