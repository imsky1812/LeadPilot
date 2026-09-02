import Link from "next/link";
import { getDb } from "@/lib/db";
import type { CampaignRow } from "@/lib/types";

// The dashboard reads the campaigns table on every request, so it can never be
// prerendered or cached.
export const dynamic = "force-dynamic";

/** A campaign row with the two embedded aggregate counts PostgREST returns. */
type CampaignListRow = CampaignRow & {
  leads: { count: number }[] | null;
  messages: { count: number }[] | null;
};

type LoadResult =
  | { ok: true; campaigns: CampaignListRow[] }
  | { ok: false; detail: string };

/**
 * Read every campaign with its lead and message counts.
 *
 * Failures are returned, not thrown: an unhandled throw in a server component
 * replaces the whole page with the Next.js error screen, and a missing env var
 * or a dropped database connection should still leave the user a working
 * "New campaign" button and a message telling them what broke.
 */
async function loadCampaigns(): Promise<LoadResult> {
  try {
    const db = getDb();
    const { data, error } = await db
      .from("campaigns")
      .select("*, leads(count), messages(count)")
      .order("created_at", { ascending: false });

    if (error) return { ok: false, detail: error.message };
    return { ok: true, campaigns: (data ?? []) as CampaignListRow[] };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const statusStyles: Record<CampaignRow["status"], string> = {
  draft: "bg-neutral-100 text-neutral-700",
  researching: "bg-blue-50 text-blue-700",
  ready: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function Home() {
  const result = await loadCampaigns();

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Campaigns</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Catalog in, researched leads and drafted outreach out.
          </p>
        </div>
        <Link
          href="/campaigns/new"
          className="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New campaign
        </Link>
      </div>

      {!result.ok ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-medium text-red-800">Could not load campaigns.</p>
          <p className="mt-1 text-sm text-red-700">{result.detail}</p>
          <p className="mt-3 text-xs text-red-600">
            Check that NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, then reload.
          </p>
        </div>
      ) : result.campaigns.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center">
          <p className="text-sm text-neutral-500">No campaigns yet.</p>
          <Link
            href="/campaigns/new"
            className="mt-3 inline-block text-sm font-medium text-neutral-900 underline underline-offset-4"
          >
            Create your first campaign
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {result.campaigns.map((c) => (
            <li key={c.id}>
              <Link
                href={`/campaigns/${c.id}`}
                className="block rounded-lg border border-neutral-200 p-5 hover:border-neutral-400"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="font-medium text-neutral-900">{c.name}</h2>
                    <p className="truncate text-sm text-neutral-600">{c.product_name}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusStyles[c.status] ?? statusStyles.draft}`}
                  >
                    {c.status}
                  </span>
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  {plural(c.leads?.[0]?.count ?? 0, "lead")} ·{" "}
                  {plural(c.messages?.[0]?.count ?? 0, "message")} ·{" "}
                  {c.research_mode === "web" ? "web research" : "simulated"} ·{" "}
                  {formatDate(c.created_at)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
