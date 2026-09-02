import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import type { CampaignRow, LeadRow, MessageRow } from "@/lib/types";
import { CampaignView } from "./campaign-view";

// Leads and messages change on every research or draft run, so this page can
// never be prerendered or cached.
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LoadResult =
  | { ok: true; campaign: CampaignRow; leads: LeadRow[]; messages: MessageRow[] }
  | { ok: false; missing: true }
  | { ok: false; missing: false; detail: string };

/**
 * Read one campaign with its leads and messages.
 *
 * Failures are returned rather than thrown. `getDb()` throws when the env vars
 * are missing, and an unhandled throw in a server component replaces the whole
 * page with the Next.js error screen — the same reasoning as `loadCampaigns()`
 * on the home dashboard.
 *
 * A missing campaign and a database failure are kept distinct: `maybeSingle()`
 * reports "no rows" as `data: null` with no error, so a genuine outage can
 * never be mistaken for a 404.
 */
async function loadCampaign(id: string): Promise<LoadResult> {
  try {
    const db = getDb();

    const { data: campaign, error: campaignError } = await db
      .from("campaigns")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (campaignError) return { ok: false, missing: false, detail: campaignError.message };
    if (!campaign) return { ok: false, missing: true };

    // Same ordering as GET /api/campaigns/:id, so the client refetch after a
    // draft run does not silently reshuffle the list under the user.
    const { data: leads, error: leadsError } = await db
      .from("leads")
      .select("*")
      .eq("campaign_id", id)
      .order("fit_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: true });
    if (leadsError) return { ok: false, missing: false, detail: leadsError.message };

    const { data: messages, error: messagesError } = await db
      .from("messages")
      .select("*")
      .eq("campaign_id", id)
      .order("created_at", { ascending: true });
    if (messagesError) return { ok: false, missing: false, detail: messagesError.message };

    return {
      ok: true,
      campaign: campaign as CampaignRow,
      leads: (leads ?? []) as LeadRow[],
      messages: (messages ?? []) as MessageRow[],
    };
  } catch (err) {
    return {
      ok: false,
      missing: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Postgres rejects a malformed uuid with a cast error, which would surface as
  // "could not load campaign" rather than a 404. Check the shape first.
  if (!UUID_RE.test(id)) notFound();

  const result = await loadCampaign(id);
  if (!result.ok && result.missing) notFound();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl px-6 py-12">
        <div className="rounded-md border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-medium text-red-800">Could not load this campaign.</p>
          <p className="mt-1 text-sm text-red-700">{result.detail}</p>
          <p className="mt-3 text-xs text-red-600">
            Check that NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, then reload.
          </p>
        </div>
        <Link
          href="/"
          className="mt-6 inline-block text-sm font-medium text-neutral-900 underline underline-offset-4"
        >
          Back to campaigns
        </Link>
      </main>
    );
  }

  return (
    <CampaignView
      campaign={result.campaign}
      initialLeads={result.leads}
      initialMessages={result.messages}
    />
  );
}
