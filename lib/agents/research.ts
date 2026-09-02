import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LeadsSchema, type Lead, type ResearchMode } from "../schemas";
import { AgentError } from "../errors";
import { MODEL } from "../anthropic";

export interface ResearchInput {
  product_name: string;
  product_description: string;
  target_market: string;
  extra_context?: string | null;
  lead_count: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

const STRUCTURE_SYSTEM = `You are a B2B lead researcher. You produce structured lists of
target companies that plausibly need a given product.

Rules:
- Every lead must include a specific fit_reason that references something concrete about
  that company and ties it to the product. Never write a generic reason that would apply
  to any company in the market.
- fit_score is 0-100 and reflects how well the company matches the stated target market.
- contact_role is the job title most likely to own this purchase. contact_name is optional;
  only supply one if it appeared in the research notes. Never invent a named person.
- If research notes are supplied, ground every lead in them and carry the source URLs into
  the sources array. If no notes are supplied, the leads are informed guesses and sources
  must be an empty array.`;

export function catalogBlock(input: ResearchInput): string {
  return [
    `Product: ${input.product_name}`,
    `Description: ${input.product_description}`,
    `Target market: ${input.target_market}`,
    input.extra_context ? `Additional catalog context:\n${input.extra_context}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function firstText(response: any): string {
  const block = (response?.content ?? []).find((b: any) => b.type === "text");
  return block?.text ?? "";
}

/**
 * Stage 2 of research: turn optional prose research notes plus the catalog into
 * schema-validated leads. Always runs, in both simulated and web mode.
 */
export async function structureLeads(
  input: ResearchInput,
  notes: string | null,
  client: Anthropic,
): Promise<{ leads: Lead[]; usage: Usage }> {
  const userPrompt = [
    catalogBlock(input),
    "",
    notes
      ? `Research notes gathered from the web:\n${notes}`
      : "No research notes are available. Produce informed, plausible leads and leave sources empty.",
    "",
    `Return exactly ${input.lead_count} leads.`,
  ].join("\n");

  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let lastRaw = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: any[] = [{ role: "user", content: userPrompt }];
    if (attempt === 1) {
      messages.push({
        role: "user",
        content:
          "Your previous response did not match the required schema. Return only data matching the schema exactly.",
      });
    }

    let response: any;
    try {
      response = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        system: STRUCTURE_SYSTEM,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: zodOutputFormat(LeadsSchema),
        },
        messages,
      } as any);
    } catch (err) {
      // A transport or API failure is the caller's to classify — toErrorResponse
      // maps the typed SDK errors, so never fold one into an AgentError.
      if (err instanceof Anthropic.APIError) throw err;
      // Anything else here is schema validation throwing. zodOutputFormat flattens
      // numeric bounds into a description, so an out-of-range field survives
      // constrained decoding and only fails at the Zod step — same failed attempt
      // as parsed_output: null, so it retries on the same budget.
      lastRaw = err instanceof Error ? err.message : String(err);
      continue;
    }

    usage = {
      input_tokens: usage.input_tokens + (response.usage?.input_tokens ?? 0),
      output_tokens: usage.output_tokens + (response.usage?.output_tokens ?? 0),
    };

    // A refusal is a 200 with no usable content. Never retry it — surface it.
    if (response.stop_reason === "refusal") {
      const detail = response.stop_details?.explanation ?? response.stop_details?.category ?? "";
      throw new AgentError(`Claude declined this research request. ${detail}`.trim());
    }

    if (response.parsed_output) {
      const leads = (response.parsed_output.leads as Lead[]).slice(0, input.lead_count);
      return { leads, usage };
    }

    lastRaw = firstText(response);
  }

  throw new AgentError(
    "Claude returned research output that did not match the lead schema, twice.",
    lastRaw || "the model's raw text was not valid structured output",
  );
}

const SEARCH_SYSTEM = `You are a B2B lead researcher. Search the web for real companies that
match the target market for the given product.

For each company you find, note: the company name, its website domain, its location, the job
title that would own this purchase, and one concrete, specific fact that explains why this
product fits them. Cite the URL you found each fact on.

Prefer specific mid-market companies over household names. Do not invent facts — if you cannot
find something, say so.`;

const MAX_SEARCH_TURNS = 6;

/** Throws if any web_search_tool_result block carries an error object rather than a results array. */
function assertNoSearchErrors(response: any): void {
  for (const block of response?.content ?? []) {
    if (block.type !== "web_search_tool_result") continue;
    // Success: content is an array of results. Failure: content is a single error object.
    if (!Array.isArray(block.content)) {
      const code = block.content?.error_code ?? "unknown_error";
      throw new AgentError(`Web search failed: ${code}`);
    }
  }
}

/** Stage 1 of research. Only called in web mode. */
export async function gatherResearchNotes(
  input: ResearchInput,
  client: Anthropic,
): Promise<{ notes: string; usage: Usage }> {
  const messages: any[] = [
    {
      role: "user",
      content: `${catalogBlock(input)}\n\nFind about ${input.lead_count} real companies that fit this target market. Report what you find with sources.`,
    },
  ];

  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const collected: string[] = [];

  for (let turn = 0; turn < MAX_SEARCH_TURNS; turn++) {
    const response: any = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SEARCH_SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
      messages,
    } as any);

    usage = {
      input_tokens: usage.input_tokens + (response.usage?.input_tokens ?? 0),
      output_tokens: usage.output_tokens + (response.usage?.output_tokens ?? 0),
    };

    assertNoSearchErrors(response);

    if (response.stop_reason === "refusal") {
      const detail = response.stop_details?.explanation ?? response.stop_details?.category ?? "";
      throw new AgentError(`Claude declined this search. ${detail}`.trim());
    }

    const text = firstText(response);
    if (text) collected.push(text);

    // A long search turn stops here. Unhandled, the run ends silently with nothing.
    // Push the paused assistant turn back and re-request — the server sees the
    // trailing server_tool_use block and resumes. Never add a "Continue." message.
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    break;
  }

  const notes = collected.join("\n\n").trim();
  if (!notes) {
    throw new AgentError("Web search returned no usable research notes.");
  }
  return { notes, usage };
}

/** Full research run: optional search, then structuring. */
export async function researchLeads(
  input: ResearchInput,
  mode: ResearchMode,
  client: Anthropic,
  onProgress?: (msg: string) => void,
): Promise<{ leads: Lead[]; usage: Usage; sourced: boolean }> {
  let notes: string | null = null;
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };

  if (mode === "web") {
    onProgress?.("Searching the web for matching companies…");
    const gathered = await gatherResearchNotes(input, client);
    notes = gathered.notes;
    usage = gathered.usage;
    onProgress?.("Research gathered. Structuring leads…");
  } else {
    onProgress?.("Generating simulated leads from the catalog…");
  }

  const structured = await structureLeads(input, notes, client);

  return {
    leads: structured.leads,
    usage: {
      input_tokens: usage.input_tokens + structured.usage.input_tokens,
      output_tokens: usage.output_tokens + structured.usage.output_tokens,
    },
    sourced: mode === "web" && structured.leads.some((l) => l.sources.length > 0),
  };
}
