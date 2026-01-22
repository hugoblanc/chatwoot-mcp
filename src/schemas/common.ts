/**
 * Common Zod schemas used across multiple tools
 */

import { z } from "zod";
import { ResponseFormat, DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

/**
 * Pagination schema for list operations
 */
export const PaginationSchema = z.object({
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Page number for pagination (starts at 1)"),
});

/**
 * Response format schema
 */
export const ResponseFormatSchema = z.object({
  response_format: z
    .nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
});

/**
 * Account ID schema
 */
export const AccountIdSchema = z.object({
  account_id: z
    .number()
    .int()
    .positive()
    .describe("The numeric ID of the account"),
});
