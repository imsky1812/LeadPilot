import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { DraftSchema, type Draft } from "../schemas";
import { AgentError } from "../errors";
import { MODEL } from "../anthropic";
import type { LeadRow } from "../types";
import type { Usage } from "./research";

export interface DraftContext {
  product_name: string;
  product_description: string;
  target_market: string;
  extra_context?: string | null;
}

export type DraftResult =
  | { lead_id: string; ok: true; draft: Draft; usage: Usage }
  | { lead_id: string; ok: false; error: string };

const DRAFT_SYSTEM = `You write short, specific B2B outreach emails.

Rules:
- Under 130 words. No preamble, no "I hope this finds you well".
- Open with the specific thing about their company that prompted the email — the fit reason.
- One clear value statement tied to the product, then one low-friction ask.
- Plain text. No markdown, no bullet lists, no emoji.
- Address the role, not a named person, unless a contact name is supplied.
- Never claim a fact about the company beyond what the fit reason states.
- personalization_note explains, for the human reviewer, what the email hooked on. It is not
  part of the email.`;

export async function draftMessage(
  ctx: DraftContext,
  lead: LeadRow,
  client: Anthropic,
): Promise<{ draft: Draft; usage: Usage }> {
  const prompt = [
    `Product: ${ctx.product_name}`,
    `Description: ${ctx.product_description}`,
    `Target market: ${ctx.target_market}`,
    ctx.extra_context ? `Catalog context:\n${ctx.extra_context}` : null,
    "",
    `Recipient company: ${lead.company_name}`,
    lead.location ? `Location: ${lead.location}` : null,
    `Recipient role: ${lead.contact_role}`,
    lead.contact_name ? `Recipient name: ${lead.contact_name}` : null,
    `Why they fit: ${lead.fit_reason}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response: any = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: DRAFT_SYSTEM,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: zodOutputFormat(DraftSchema),
    },
    messages: [{ role: "user", content: prompt }],
  } as any);

  if (response.stop_reason === "refusal") {
    const detail = response.stop_details?.explanation ?? response.stop_details?.category ?? "";
    throw new AgentError(`Claude declined to draft this message. ${detail}`.trim());
  }
  if (!response.parsed_output) {
    throw new AgentError(`Draft for ${lead.company_name} did not match the schema.`);
  }

  return {
    draft: response.parsed_output as Draft,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}

/** Draft for many leads with a concurrency ceiling. One lead's failure never fails the batch. */
export async function draftBatch(
  ctx: DraftContext,
  leads: LeadRow[],
  client: Anthropic,
  concurrency = 3,
): Promise<DraftResult[]> {
  const results: DraftResult[] = new Array(leads.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= leads.length) return;
      const lead = leads[index];
      try {
        const { draft, usage } = await draftMessage(ctx, lead, client);
        // Carried per lead so the route can total it into agent_runs. Research runs
        // record their tokens; draft runs recording nulls would be an odd asymmetry
        // in the one table meant for observability.
        results[index] = { lead_id: lead.id, ok: true, draft, usage };
      } catch (err) {
        // A rejected credential fails identically for every lead. Isolating it would
        // spend one call per lead and bury the cause under N per-lead strings, so let
        // it abort the run and reach toErrorResponse with its type intact. Everything
        // else — including rate limits, which are transient and lead-specific in
        // effect — stays isolated.
        if (err instanceof Anthropic.AuthenticationError) throw err;
        results[index] = {
          lead_id: lead.id,
          ok: false,
          error: err instanceof Error ? err.message : "Unknown drafting error",
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, leads.length) }, worker));
  return results;
}
