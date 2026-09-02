import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { structureLeads, type ResearchInput } from "./research";
import { AgentError } from "../errors";

const input: ResearchInput = {
  product_name: "RouteIQ",
  product_description: "Route optimization for refrigerated fleets.",
  target_market: "Mid-size European cold chain operators",
  extra_context: null,
  lead_count: 2,
};

function lead(over: Partial<any> = {}) {
  return {
    company_name: "Northwind Logistics",
    company_domain: "northwind.example",
    contact_name: null,
    contact_role: "VP Operations",
    location: "Rotterdam, NL",
    fit_reason: "Cold chain fleet with public route-waste commentary.",
    fit_score: 80,
    sources: [],
    ...over,
  };
}

function fakeClient(parse: any): Anthropic {
  return { messages: { parse } } as unknown as Anthropic;
}

describe("structureLeads", () => {
  it("returns parsed leads and usage", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { leads: [lead(), lead({ company_name: "Frostline" })] },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await structureLeads(input, null, fakeClient(parse));

    expect(result.leads).toHaveLength(2);
    expect(result.leads[0].company_name).toBe("Northwind Logistics");
    expect(result.usage.input_tokens).toBe(100);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("retries exactly once when parsed_output is null, then succeeds", async () => {
    const parse = vi
      .fn()
      .mockResolvedValueOnce({
        parsed_output: null,
        stop_reason: "end_turn",
        content: [{ type: "text", text: "here are some leads, not json" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        parsed_output: { leads: [lead()] },
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 8 },
      });

    const result = await structureLeads(input, null, fakeClient(parse));

    expect(parse).toHaveBeenCalledTimes(2);
    expect(result.leads).toHaveLength(1);
  });

  it("throws AgentError after a second parse failure, carrying the raw text", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: null,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "still not json" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await expect(structureLeads(input, null, fakeClient(parse))).rejects.toThrow(AgentError);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("throws AgentError on a refusal without retrying", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: null,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    await expect(structureLeads(input, null, fakeClient(parse))).rejects.toThrow(/declin|refus/i);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("truncates to lead_count when the model overshoots", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { leads: [lead(), lead(), lead(), lead()] },
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await structureLeads(input, null, fakeClient(parse));
    expect(result.leads).toHaveLength(2);
  });

  // zodOutputFormat flattens numeric bounds into a schema description rather than
  // JSON Schema minimum/maximum, so an out-of-range fit_score reaches Zod and makes
  // messages.parse throw instead of returning parsed_output: null. Same failure,
  // different shape — it must retry and end as an AgentError, not a raw ZodError.
  it("treats a thrown schema validation error as a failed attempt", async () => {
    const parse = vi.fn().mockRejectedValue(new Error("fit_score: Too big: expected <=100"));

    await expect(structureLeads(input, null, fakeClient(parse))).rejects.toThrow(AgentError);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("rethrows an SDK APIError untouched so toErrorResponse can type it", async () => {
    const AnthropicNs = (await import("@anthropic-ai/sdk")).default;
    const apiErr = new AnthropicNs.RateLimitError(429, { type: "error" }, "slow down", new Headers());
    const parse = vi.fn().mockRejectedValue(apiErr);

    await expect(structureLeads(input, null, fakeClient(parse))).rejects.toBe(apiErr);
    expect(parse).toHaveBeenCalledOnce();
  });
});

import { gatherResearchNotes, researchLeads } from "./research";

function searchResponse(over: Partial<any> = {}) {
  return {
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 40 },
    content: [
      {
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", title: "Northwind", url: "https://northwind.example" }],
      },
      { type: "text", text: "Northwind Logistics runs 200 reefer trucks in Rotterdam." },
    ],
    ...over,
  };
}

function fakeSearchClient(create: any): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

describe("gatherResearchNotes", () => {
  it("returns the text notes from a completed search", async () => {
    const create = vi.fn().mockResolvedValue(searchResponse());
    const result = await gatherResearchNotes(input, fakeSearchClient(create));
    expect(result.notes).toContain("Northwind Logistics");
    expect(create).toHaveBeenCalledOnce();
  });

  it("resumes a pause_turn instead of returning a truncated result", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        searchResponse({
          stop_reason: "pause_turn",
          content: [{ type: "text", text: "Searching…" }],
        }),
      )
      .mockResolvedValueOnce(searchResponse());

    const result = await gatherResearchNotes(input, fakeSearchClient(create));

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.notes).toContain("Northwind Logistics");
  });

  it("treats a search error object as an error, not an array to index", async () => {
    const create = vi.fn().mockResolvedValue(
      searchResponse({
        content: [
          { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
          { type: "text", text: "" },
        ],
      }),
    );

    await expect(gatherResearchNotes(input, fakeSearchClient(create))).rejects.toThrow(
      /max_uses_exceeded/,
    );
  });

  // The resume must re-send the paused assistant turn and nothing else — an extra
  // "Continue." user message stops the server resuming from where it left off.
  it("resumes by pushing the paused assistant turn back, with no filler user message", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        searchResponse({ stop_reason: "pause_turn", content: [{ type: "text", text: "Searching…" }] }),
      )
      .mockResolvedValueOnce(searchResponse());

    await gatherResearchNotes(input, fakeSearchClient(create));

    const secondCall = create.mock.calls[1][0];
    expect(secondCall.messages).toHaveLength(2);
    expect(secondCall.messages[0].role).toBe("user");
    expect(secondCall.messages[1].role).toBe("assistant");
    expect(secondCall.messages[1].content).toEqual([{ type: "text", text: "Searching…" }]);
  });
});

describe("researchLeads", () => {
  it("skips search entirely in simulated mode and marks leads unsourced", async () => {
    const create = vi.fn();
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { leads: [lead({ sources: [] }), lead({ sources: [] })] },
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = { messages: { create, parse } } as unknown as Anthropic;

    const result = await researchLeads(input, "simulated", client);

    expect(create).not.toHaveBeenCalled();
    expect(result.sourced).toBe(false);
    expect(result.leads.every((l) => l.sources.length === 0)).toBe(true);
  });

  it("searches in web mode and reports sourced when leads carry source URLs", async () => {
    const create = vi.fn().mockResolvedValue(searchResponse());
    const parse = vi.fn().mockResolvedValue({
      parsed_output: {
        leads: [lead({ sources: [{ title: "Northwind", url: "https://northwind.example" }] })],
      },
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = { messages: { create, parse } } as unknown as Anthropic;

    const result = await researchLeads(input, "web", client);

    expect(create).toHaveBeenCalledOnce();
    expect(result.sourced).toBe(true);
  });

  it("sums usage across both stages", async () => {
    const create = vi.fn().mockResolvedValue(searchResponse());
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { leads: [lead()] },
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = { messages: { create, parse } } as unknown as Anthropic;

    const result = await researchLeads(input, "web", client);

    expect(result.usage).toEqual({ input_tokens: 110, output_tokens: 45 });
  });
});
