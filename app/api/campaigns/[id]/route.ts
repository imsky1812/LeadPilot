import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { toErrorResponse } from "@/lib/errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/campaigns/:id -> the campaign with its leads and messages. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
    }

    const db = getDb();

    // maybeSingle, not single: single() turns "no rows" into an error, which would
    // make a genuine database failure indistinguishable from a missing campaign.
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

    const { data: leads, error: leadsError } = await db
      .from("leads")
      .select("*")
      .eq("campaign_id", id)
      .order("fit_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: true });
    if (leadsError) {
      return NextResponse.json(
        { error: "Could not load leads", detail: leadsError.message },
        { status: 500 },
      );
    }

    const { data: messages, error: messagesError } = await db
      .from("messages")
      .select("*")
      .eq("campaign_id", id)
      .order("created_at", { ascending: true });
    if (messagesError) {
      return NextResponse.json(
        { error: "Could not load messages", detail: messagesError.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ campaign, leads: leads ?? [], messages: messages ?? [] });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
