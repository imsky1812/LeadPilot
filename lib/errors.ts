import Anthropic from "@anthropic-ai/sdk";

/** Raised when the model responds successfully but the output is unusable. */
export class AgentError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "AgentError";
    this.detail = detail;
  }
}

export interface ErrorResponse {
  status: number;
  body: { error: string; detail?: string };
}

/**
 * Map a thrown value to an HTTP status and a safe user-facing message.
 * Ordered most-specific first — never reorder these branches, and never
 * string-match on error messages.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof AgentError) {
    return { status: 422, body: { error: error.message, detail: error.detail } };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return {
      status: 500,
      body: { error: "Claude rejected the credentials. Check ANTHROPIC_API_KEY." },
    };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return {
      status: 429,
      body: { error: "Claude rate limit reached. Wait a moment and retry." },
    };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { status: 400, body: { error: "Claude rejected the request.", detail: error.message } };
  }
  if (error instanceof Anthropic.APIError) {
    return {
      status: error.status ?? 500,
      body: { error: "Claude API error.", detail: error.message },
    };
  }
  return { status: 500, body: { error: "Unexpected server error." } };
}
