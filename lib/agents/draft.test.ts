import { describe, it, expect, vi } from "vitest";
import AnthropicSDK from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { draftMessage, draftBatch, type DraftContext } from "./draft";
import type { LeadRow } from "../types";
import { AgentError } from "../errors";

const ctx: DraftContext = {
  product_name: "RouteIQ",
  product_description: "Route optimization for refrigerated fleets.",
  target_market: "Mid-size European cold chain operators",
  extra_context: null,
};

function leadRow(id: string, over: Partial<LeadRow> = {}): LeadRow {
  return {
    id,
    campaign_id: "c1",
    company_name: "Northwind Logistics",
    company_domain: "northwind.example",
    contact_name: null,
    contact_role: "VP Operations",
    location: "Rotterdam, NL",
    fit_reason: "Cold chain fleet with public route-waste commentary.",
    fit_score: 80,
    sourced: false,
    sources: [],
    status: "new",
    follow_up_at: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

const goodDraft = {
  parsed_output: {
    subject: "Cutting reefer spoilage at Northwind",
    body: "Hi there — noticed Northwind runs 200 reefer trucks…",
    personalization_note: "Hooked on their public route-waste commentary.",
  },
  stop_reason: "end_turn",
  usage: { input_tokens: 50, output_tokens: 30 },
};

describe("draftMessage", () => {
  it("returns a parsed draft", async () => {
    const parse = vi.fn().mockResolvedValue(goodDraft);
    const client = { messages: { parse } } as unknown as Anthropic;

    const { draft } = await draftMessage(ctx, leadRow("l1"), client);

    expect(draft.subject).toContain("Northwind");
    expect(draft.personalization_note).toBeTruthy();
  });

  it("throws AgentError when parsed_output is null", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: null,
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const client = { messages: { parse } } as unknown as Anthropic;

    await expect(draftMessage(ctx, leadRow("l1"), client)).rejects.toThrow(AgentError);
  });
});

describe("draftBatch", () => {
  it("isolates a single lead failure without failing the batch", async () => {
    const parse = vi.fn().mockImplementation((args: any) => {
      const prompt = JSON.stringify(args.messages);
      if (prompt.includes("Frostline")) return Promise.reject(new Error("boom"));
      return Promise.resolve(goodDraft);
    });
    const client = { messages: { parse } } as unknown as Anthropic;

    const results = await draftBatch(
      ctx,
      [leadRow("l1"), leadRow("l2", { company_name: "Frostline" }), leadRow("l3")],
      client,
      2,
    );

    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const failed = results.find((r) => !r.ok);
    expect(failed?.lead_id).toBe("l2");
  });

  it("respects the concurrency ceiling", async () => {
    let inFlight = 0;
    let peak = 0;
    const parse = vi.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return goodDraft;
    });
    const client = { messages: { parse } } as unknown as Anthropic;

    await draftBatch(ctx, [1, 2, 3, 4, 5, 6].map((n) => leadRow(`l${n}`)), client, 2);

    expect(peak).toBeLessThanOrEqual(2);
  });

  // A bad key fails identically for every lead. Isolating it would burn one call per
  // lead and bury the cause under N per-lead error strings, when toErrorResponse
  // already turns the typed error into "Check ANTHROPIC_API_KEY".
  it("aborts the whole batch on an authentication error rather than isolating it", async () => {
    const authErr = new AnthropicSDK.AuthenticationError(
      401,
      { type: "error" },
      "bad key",
      new Headers(),
    );
    const parse = vi.fn().mockRejectedValue(authErr);
    const client = { messages: { parse } } as unknown as Anthropic;

    await expect(
      draftBatch(ctx, [leadRow("l1"), leadRow("l2"), leadRow("l3")], client, 2),
    ).rejects.toBe(authErr);
  });
});
