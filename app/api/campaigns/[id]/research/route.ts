import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAnthropic } from "@/lib/anthropic";
import { researchLeads, type ResearchInput } from "@/lib/agents/research";
import { toErrorResponse } from "@/lib/errors";
import { startRun, finishRun } from "@/lib/runs";
import type { CampaignRow } from "@/lib/types";

export const maxDuration = 300;

function sse(event: string, data: unknown): string {
  // JSON.stringify escapes newlines, so every payload stays on one `data:` line.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  let campaign: CampaignRow;
  let db: ReturnType<typeof getDb>;

  // Everything before the first byte of the stream can still answer with a real
  // HTTP status. Once the stream opens the status line is gone and failures have
  // to travel as an `error` event instead.
  try {
    db = getDb();
    // maybeSingle, not single: single() reports "no rows" as an error, so error
    // and not-found become indistinguishable and a real database failure would be
    // reported to the user as "Campaign not found".
    const { data, error } = await db.from("campaigns").select("*").eq("id", id).maybeSingle();
    if (error) {
      return NextResponse.json(
        { error: "Could not load campaign", detail: error.message },
        { status: 500 },
      );
    }
    if (!data) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }
    campaign = data as CampaignRow;
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }

  const c = campaign;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          // Client hung up mid-run. Stop writing, but let the run finish so the
          // leads are still persisted and agent_runs is still closed out.
          open = false;
        }
      };

      const runId = await startRun(c.id, "research");
      await db
        .from("campaigns")
        .update({ status: "researching", updated_at: new Date().toISOString() })
        .eq("id", c.id);

      try {
        const input: ResearchInput = {
          product_name: c.product_name,
          product_description: c.product_description,
          target_market: c.target_market,
          extra_context: c.extra_context,
          lead_count: c.lead_count,
        };

        const { leads, usage } = await researchLeads(input, c.research_mode, getAnthropic(), (msg) =>
          send("progress", { message: msg }),
        );

        send("progress", { message: `Saving ${leads.length} leads…` });

        const rows = leads.map((l) => ({
          campaign_id: c.id,
          company_name: l.company_name,
          company_domain: l.company_domain,
          contact_name: l.contact_name,
          contact_role: l.contact_role,
          location: l.location,
          fit_reason: l.fit_reason,
          fit_score: l.fit_score,
          // Per-lead honesty flag: a web run can legitimately return a mix.
          sourced: l.sources.length > 0,
          sources: l.sources,
        }));

        let inserted: unknown[] = [];
        if (rows.length > 0) {
          const { data, error: insertError } = await db.from("leads").insert(rows).select();
          if (insertError) throw new Error(insertError.message);
          inserted = data ?? [];
        }

        for (const row of inserted) send("lead", row);

        await db
          .from("campaigns")
          .update({ status: "ready", updated_at: new Date().toISOString() })
          .eq("id", c.id);
        await finishRun(runId, "succeeded", {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        });

        send("done", { count: inserted.length });
      } catch (err) {
        const { body } = toErrorResponse(err);
        await db
          .from("campaigns")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", c.id);
        await finishRun(runId, "failed", { error: body.detail ?? body.error });
        send("error", body);
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops nginx-style proxies from buffering the stream into one response.
      "X-Accel-Buffering": "no",
    },
  });
}
