import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getAnthropic, MODEL } from "@/lib/anthropic";
import { draftBatch, type DraftContext, type DraftResult } from "@/lib/agents/draft";
import { toErrorResponse } from "@/lib/errors";
import { startRun, finishRun } from "@/lib/runs";
import type { CampaignRow, LeadRow, MessageRow } from "@/lib/types";

export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  lead_ids: z.array(z.string().regex(UUID_RE, "must be a uuid")).optional(),
});

/** A message at one of these statuses is a human artefact and is never replaced. */
type LockedStatus = Extract<MessageRow["status"], "approved" | "sent">;
const LOCKED_STATUSES: readonly MessageRow["status"][] = ["approved", "sent"];

type Succeeded = Extract<DraftResult, { ok: true }>;
type Failed = Extract<DraftResult, { ok: false }>;

const isSucceeded = (r: DraftResult): r is Succeeded => r.ok;
const isFailed = (r: DraftResult): r is Failed => !r.ok;

/**
 * POST /api/campaigns/:id/draft
 *
 * Body `{ lead_ids?: string[] }`:
 *  - omitted  -> draft for every lead in the campaign that has no message at all.
 *  - provided -> regenerate for exactly those leads, replacing an existing `draft`
 *                message but never one the human moved to `approved` or `sent`.
 *
 * Every write this route makes against `messages` is filtered by `status = draft`.
 * That filter is the only thing standing between a regeneration and the loss of a
 * message a user has already reviewed, edited and approved. Do not remove it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let runId: string | null = null;

  try {
    const { id } = await params;
    // Guard before the query so a malformed segment is a 400, not a Postgres 22P02 500.
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
    }

    const parsedBody = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          detail: parsedBody.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        { status: 400 },
      );
    }
    const { lead_ids } = parsedBody.data;
    // Presence, not length: `{"lead_ids": []}` asks for nothing, and must not be read
    // as "no selection was given, so draft for the whole campaign".
    const explicit = lead_ids !== undefined;

    const db = getDb();

    // maybeSingle, not single: single() reports "no rows" as a PGRST116 error, which
    // would make a real database failure indistinguishable from a missing campaign.
    const { data: campaign, error: campaignError } = await db
      .from("campaigns")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (campaignError) {
      return NextResponse.json(
        { error: "Could not load campaign", detail: campaignError.message },
        { status: 500 },
      );
    }
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    const c = campaign as CampaignRow;

    if (explicit && lead_ids.length === 0) {
      return NextResponse.json({ drafted: 0, failed: [], skipped: [] });
    }

    // Always scoped to this campaign, so an id belonging to another campaign never
    // comes back and is reported as skipped rather than drafted.
    let query = db.from("leads").select("*").eq("campaign_id", id);
    if (explicit) query = query.in("id", lead_ids);
    const { data: leadRows, error: leadsError } = await query;
    if (leadsError) {
      return NextResponse.json(
        { error: "Could not load leads", detail: leadsError.message },
        { status: 500 },
      );
    }
    const leads = (leadRows ?? []) as LeadRow[];

    const { data: messageRows, error: messagesError } = await db
      .from("messages")
      .select("lead_id, status")
      .eq("campaign_id", id);
    if (messagesError) {
      return NextResponse.json(
        { error: "Could not load existing messages", detail: messagesError.message },
        { status: 500 },
      );
    }

    // A lead can carry more than one message — nothing in the schema forbids it — so
    // fold per lead rather than keying a map by lead_id and letting the last row win.
    // A single approved row must lock the lead whatever order the rows arrive in.
    const locks = new Map<string, LockedStatus | null>();
    for (const m of (messageRows ?? []) as Pick<MessageRow, "lead_id" | "status">[]) {
      const existing = locks.get(m.lead_id) ?? null;
      const locked = LOCKED_STATUSES.includes(m.status) ? (m.status as LockedStatus) : null;
      locks.set(m.lead_id, existing ?? locked);
    }

    const skipped: { lead_id: string; reason: LockedStatus | "not_in_campaign" }[] = [];
    let targets: LeadRow[];

    if (explicit) {
      const found = new Set(leads.map((l) => l.id));
      for (const wanted of lead_ids) {
        if (!found.has(wanted)) skipped.push({ lead_id: wanted, reason: "not_in_campaign" });
      }
      targets = leads.filter((l) => {
        const locked = locks.get(l.id);
        if (locked) {
          skipped.push({ lead_id: l.id, reason: locked });
          return false;
        }
        return true;
      });
    } else {
      // Default pass: only leads with no message at all. A lead already holding a
      // draft is left alone — replacing it is an explicit, opt-in request.
      targets = leads.filter((l) => !locks.has(l.id));
    }

    if (targets.length === 0) {
      return NextResponse.json({ drafted: 0, failed: [], skipped });
    }

    runId = await startRun(c.id, "draft");

    const ctx: DraftContext = {
      product_name: c.product_name,
      product_description: c.product_description,
      target_market: c.target_market,
      extra_context: c.extra_context,
    };

    const results = await draftBatch(ctx, targets, getAnthropic());
    const succeeded = results.filter(isSucceeded);
    const failed = results.filter(isFailed).map((r) => ({ lead_id: r.lead_id, error: r.error }));

    if (succeeded.length > 0) {
      const succeededIds = succeeded.map((r) => r.lead_id);

      // Clear the stale draft before inserting the new one. Run over the succeeded
      // ids rather than over the snapshot taken above, so a draft written by a
      // concurrent request while we were calling Claude is replaced too instead of
      // leaving the lead holding two drafts. The `status = draft` filter is what
      // keeps an approved or sent message out of this delete's reach.
      const { error: deleteError } = await db
        .from("messages")
        .delete()
        .eq("campaign_id", c.id)
        .in("lead_id", succeededIds)
        .eq("status", "draft");
      if (deleteError) throw new Error(deleteError.message);

      // personalization_note is deliberately not persisted: the table has no column
      // for it, and it exists to steer the model toward specificity, not to be shown.
      const rows = succeeded.map((r) => ({
        lead_id: r.lead_id,
        campaign_id: c.id,
        subject: r.draft.subject,
        body: r.draft.body,
        model: MODEL,
      }));
      const { error: insertError } = await db.from("messages").insert(rows);
      if (insertError) throw new Error(insertError.message);
    }

    // A partial failure still produced work; only a run that drafted nothing at all
    // is recorded as failed. Tokens are totalled across the leads that succeeded, so
    // agent_runs reports draft spend the same way it reports research spend.
    const usage = succeeded.reduce(
      (acc, r) => ({
        input_tokens: acc.input_tokens + r.usage.input_tokens,
        output_tokens: acc.output_tokens + r.usage.output_tokens,
      }),
      { input_tokens: 0, output_tokens: 0 },
    );

    await finishRun(runId, succeeded.length === 0 && failed.length > 0 ? "failed" : "succeeded", {
      error: failed.length ? `${failed.length} lead(s) failed` : undefined,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    });

    return NextResponse.json({ drafted: succeeded.length, failed, skipped });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    // No-ops when startRun never ran or could not open a row.
    await finishRun(runId, "failed", { error: body.detail ?? body.error });
    return NextResponse.json(body, { status });
  }
}
