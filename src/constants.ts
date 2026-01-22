/**
 * Shared constants for the Chatwoot MCP server
 */

/** Maximum response size in characters */
export const CHARACTER_LIMIT = 25000;

/** Response format options */
export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Default pagination limit */
export const DEFAULT_LIMIT = 20;

/** Maximum pagination limit */
export const MAX_LIMIT = 100;
