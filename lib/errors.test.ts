import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { toErrorResponse, AgentError } from "./errors";

function makeApiError(Cls: any, status: number) {
  // The SDK error constructors take (status, error, message, headers).
  return new Cls(status, { type: "error" }, "boom", new Headers());
}

describe("toErrorResponse", () => {
  it("maps RateLimitError to 429", () => {
    const res = toErrorResponse(makeApiError(Anthropic.RateLimitError, 429));
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limit/i);
  });

  it("maps AuthenticationError to 500 and names the env var", () => {
    const res = toErrorResponse(makeApiError(Anthropic.AuthenticationError, 401));
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ANTHROPIC_API_KEY");
  });

  it("maps BadRequestError to 400", () => {
    const res = toErrorResponse(makeApiError(Anthropic.BadRequestError, 400));
    expect(res.status).toBe(400);
  });

  it("maps AgentError to 422 and keeps its detail", () => {
    const res = toErrorResponse(new AgentError("Model returned unparseable JSON", "raw text here"));
    expect(res.status).toBe(422);
    expect(res.body.detail).toBe("raw text here");
  });

  it("maps an unknown error to 500 without leaking the message", () => {
    const res = toErrorResponse(new Error("connection string postgres://user:pw@host"));
    expect(res.status).toBe(500);
    expect(res.body.error).not.toContain("postgres://");
  });
});
