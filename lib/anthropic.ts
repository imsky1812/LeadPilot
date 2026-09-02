import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

let client: Anthropic | null = null;

/** Server-only. Never import from a "use client" file. */
export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client ??= new Anthropic();
  return client;
}
