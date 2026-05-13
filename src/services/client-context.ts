/**
 * Per-request Chatwoot client scope.
 *
 * The stdio entry point uses a module-level singleton (one client for the
 * whole process). The HTTP entry point creates a fresh client per incoming
 * request and runs the handler inside `clientStore.run(client, …)`. Tool
 * handlers always call `getClient()` which transparently picks whichever is
 * active — the request-scoped one if available, else the singleton.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import createClient from "openapi-fetch";
import type { paths } from "../chatwoot-types.js";

export type ChatwootHttpClient = ReturnType<typeof createClient<paths>>;

export const clientStore = new AsyncLocalStorage<ChatwootHttpClient>();
