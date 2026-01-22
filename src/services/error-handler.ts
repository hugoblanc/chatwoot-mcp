/**
 * Error handling utilities for Chatwoot API responses
 */

/**
 * Handles and formats API errors with actionable messages
 */
export function handleApiError(error: unknown): string {
  // Handle fetch errors from openapi-fetch
  if (error && typeof error === "object" && "response" in error) {
    const response = (error as any).response;

    if (response?.status) {
      switch (response.status) {
        case 400:
          return "Error: Bad request. Please check your input parameters.";
        case 401:
          return "Error: Authentication failed. Please check your API access token.";
        case 403:
          return "Error: Permission denied. You don't have access to this resource.";
        case 404:
          return "Error: Resource not found. Please check the ID is correct.";
        case 422:
          return "Error: Validation failed. Please check your input data format.";
        case 429:
          return "Error: Rate limit exceeded. Please wait before making more requests.";
        case 500:
          return "Error: Chatwoot server error. Please try again later.";
        default:
          return `Error: API request failed with status ${response.status}`;
      }
    }
  }

  // Handle network errors
  if (error instanceof Error) {
    if (error.message.includes("ECONNREFUSED")) {
      return "Error: Cannot connect to Chatwoot server. Please check the base URL and network connection.";
    }
    if (error.message.includes("ETIMEDOUT")) {
      return "Error: Request timed out. Please try again.";
    }
    return `Error: ${error.message}`;
  }

  return `Error: Unexpected error occurred: ${String(error)}`;
}
