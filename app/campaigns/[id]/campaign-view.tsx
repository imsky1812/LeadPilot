"use client";

import Link from "next/link";
import { useState } from "react";
import type { CampaignRow, LeadRow, MessageRow } from "@/lib/types";
import { LeadCard } from "./lead-card";

type Filter = "all" | "new" | "contacted" | "follow_up" | "replied" | "due";

const FILTERS: Filter[] = ["all", "new", "contacted", "follow_up", "replied", "due"];

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  new: "New",
  contacted: "Contacted",
  follow_up: "Follow-up",
  replied: "Replied",
  due: "Due",
};

// Same palette as the campaign list on the home dashboard.
const statusStyles: Record<CampaignRow["status"], string> = {
  draft: "bg-neutral-100 text-neutral-700",
  researching: "bg-blue-50 text-blue-700",
  ready: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
};

/**
 * Today in the *viewer's* timezone as YYYY-MM-DD.
 *
 * `follow_up_at` is a Postgres date set from an `<input type="date">`, which
 * speaks the local calendar. Comparing against `new Date().toISOString()` would
 * use UTC, so a user east of UTC would see the "due" window flip a day early
 * every evening.
 */
function localDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One parsed SSE frame. */
type Frame = { event: string; data: unknown };

/**
 * Split an SSE buffer into complete frames, returning the unterminated tail.
 *
 * The route emits `event: NAME\ndata: JSON\n\n`, but a frame can be split
 * across any number of reads, so the tail has to be carried forward.
 */
function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: Frame[] = [];

  for (const part of parts) {
    let event: string | null = null;
    const dataLines: string[] = [];

    for (const line of part.replace(/\r/g, "").split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!event || dataLines.length === 0) continue;

    try {
      frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
    } catch {
      // A frame we cannot parse is dropped rather than killing the read loop.
    }
  }

  return { frames, rest };
}

/** Pull `{ error, detail }` off a failed response without assuming it is JSON. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const json = await res.json();
    return json?.detail ?? json?.error ?? fallback;
  } catch {
    return `${fallback} (HTTP ${res.status})`;
  }
}

export function CampaignView({
  campaign,
  initialLeads,
  initialMessages,
}: {
  campaign: CampaignRow;
  initialLeads: LeadRow[];
  initialMessages: MessageRow[];
}) {
  const [leads, setLeads] = useState<LeadRow[]>(initialLeads);
  const [messages, setMessages] = useState<MessageRow[]>(initialMessages);
  const [status, setStatus] = useState<CampaignRow["status"]>(campaign.status);
  const [progress, setProgress] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | "research" | "draft">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  // Messages come back oldest first, so a later row wins — the newest draft for
  // a lead is the one shown.
  const messageByLead = new Map(messages.map((m) => [m.lead_id, m]));

  /** Re-read the authoritative campaign state after a run. */
  async function resync() {
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      if (Array.isArray(json.leads)) setLeads(json.leads as LeadRow[]);
      if (Array.isArray(json.messages)) setMessages(json.messages as MessageRow[]);
      if (json.campaign?.status) setStatus(json.campaign.status as CampaignRow["status"]);
    } catch {
      // A failed resync leaves the optimistic state in place and the next reload
      // corrects it. It is never surfaced as an error over a run that succeeded.
    }
  }

  async function runResearch() {
    setBusy("research");
    setError(null);
    setNotice(null);
    setProgress([]);
    setStatus("researching");

    // Existing leads are deliberately not cleared: the research route inserts
    // and never deletes, so wiping them locally would show a subset of what the
    // database actually holds until the next reload.
    let terminated = false;

    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/research`, { method: "POST" });

      // Failures before the first byte still arrive as a normal JSON status.
      // Once the stream opens they can only travel as an `error` frame.
      if (!res.ok) {
        setError(await readError(res, "Research failed to start"));
        setStatus("failed");
        return;
      }
      if (!res.body) {
        setError("The server returned no response stream.");
        setStatus("failed");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseFrames(buffer);
        buffer = rest;

        for (const { event, data } of frames) {
          const payload = (data ?? {}) as Record<string, unknown>;

          if (event === "progress") {
            const message = String(payload.message ?? "");
            if (message) setProgress((p) => [...p, message]);
          } else if (event === "lead") {
            const lead = data as LeadRow;
            if (!lead?.id) continue;
            setLeads((ls) => (ls.some((l) => l.id === lead.id) ? ls : [...ls, lead]));
          } else if (event === "error") {
            terminated = true;
            setError(String(payload.detail ?? payload.error ?? "Research failed"));
            setStatus("failed");
          } else if (event === "done") {
            terminated = true;
            const count = Number(payload.count ?? 0);
            setProgress((p) => [...p, `Found ${plural(count, "lead")}.`]);
            setStatus("ready");
          }
        }
      }

      // A stream that closes without a `done` or `error` frame means the
      // connection dropped mid-run. Say so, rather than leaving the panel on its
      // last progress line looking like it is still working.
      if (!terminated) {
        setError("The research stream ended before finishing. Reload to see what was saved.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("failed");
    } finally {
      setBusy(null);
      // Streamed rows are appended in arrival order; resync restores the
      // fit-score ordering and picks up anything the stream missed.
      await resync();
    }
  }

  async function runDrafts() {
    setBusy("draft");
    setError(null);
    setNotice(null);

    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        setError(await readError(res, "Drafting failed"));
        return;
      }

      const json = await res.json().catch(() => ({}));
      await resync();

      const drafted = Number(json.drafted ?? 0);
      const failed = Array.isArray(json.failed) ? json.failed.length : 0;

      if (failed > 0) setError(`${plural(failed, "lead")} could not be drafted.`);
      if (drafted === 0 && failed === 0) {
        setNotice("Every lead already has a draft.");
      } else if (drafted > 0) {
        setNotice(`Drafted ${plural(drafted, "message")}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function onLeadChange(updated: LeadRow) {
    setLeads((ls) => ls.map((l) => (l.id === updated.id ? updated : l)));
  }

  function onMessageChange(updated: MessageRow) {
    setMessages((ms) => ms.map((m) => (m.id === updated.id ? updated : m)));
  }

  const today = localDate();
  const horizon = localDate(7);

  // "Due" deliberately includes overdue follow-ups. A `>= today` window would
  // hide the follow-up the user is already late on, which is the one thing this
  // filter exists to surface.
  const isDue = (l: LeadRow) => !!l.follow_up_at && l.follow_up_at <= horizon;

  const visible = leads.filter((l) => {
    if (filter === "all") return true;
    if (filter === "due") return isDue(l);
    return l.status === filter;
  });

  const counts: Record<Filter, number> = {
    all: leads.length,
    new: leads.filter((l) => l.status === "new").length,
    contacted: leads.filter((l) => l.status === "contacted").length,
    follow_up: leads.filter((l) => l.status === "follow_up").length,
    replied: leads.filter((l) => l.status === "replied").length,
    due: leads.filter(isDue).length,
  };

  const draftCount = leads.filter((l) => messageByLead.has(l.id)).length;
  const undrafted = leads.length - draftCount;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-900">
        &larr; Campaigns
      </Link>

      <header className="mt-4 mb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-neutral-900">{campaign.name}</h1>
            <p className="mt-1 text-sm text-neutral-600">
              {campaign.product_name} &rarr; {campaign.target_market}
            </p>
          </div>
          <span
            className={`mt-1 shrink-0 rounded-full px-2 py-0.5 text-xs ${statusStyles[status] ?? statusStyles.draft}`}
          >
            {status}
          </span>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          {campaign.research_mode === "web" ? "Web research" : "Simulated research"} ·{" "}
          {plural(leads.length, "lead")} · {plural(draftCount, "draft")} · {counts.new} new ·{" "}
          {counts.contacted} contacted · {counts.follow_up} follow-up · {counts.replied} replied
        </p>
      </header>

      <div className="mb-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={runResearch}
          disabled={busy !== null}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 disabled:hover:bg-neutral-900"
        >
          {busy === "research" ? "Researching…" : leads.length ? "Find more leads" : "Find leads"}
        </button>
        <button
          type="button"
          onClick={runDrafts}
          disabled={busy !== null || leads.length === 0}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900 hover:border-neutral-400 disabled:opacity-50"
        >
          {busy === "draft"
            ? "Drafting…"
            : draftCount > 0 && undrafted > 0
              ? `Draft ${plural(undrafted, "message")}`
              : "Draft messages"}
        </button>
      </div>

      {progress.length > 0 && (
        <ul
          aria-live="polite"
          className="mb-6 max-h-52 space-y-1 overflow-y-auto rounded-md bg-neutral-50 p-3 text-sm text-neutral-600"
        >
          {progress.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mb-6 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {notice && !error && (
        <p
          aria-live="polite"
          className="mb-6 rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-600"
        >
          {notice}
        </p>
      )}

      {leads.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`rounded-full px-3 py-1 text-xs ${
                filter === f
                  ? "bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
              }`}
            >
              {FILTER_LABELS[f]} {counts[f]}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-4">
        {visible.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            message={messageByLead.get(lead.id) ?? null}
            today={today}
            onLeadChange={onLeadChange}
            onMessageChange={onMessageChange}
          />
        ))}

        {leads.length === 0 && busy !== "research" && (
          <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center">
            <p className="text-sm text-neutral-500">No leads yet.</p>
            <p className="mt-1 text-xs text-neutral-500">
              Run research to find companies matching {campaign.target_market}.
            </p>
          </div>
        )}

        {leads.length === 0 && busy === "research" && progress.length === 0 && (
          <p className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
            Starting research…
          </p>
        )}

        {leads.length > 0 && visible.length === 0 && (
          <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
            No leads match this filter.
          </p>
        )}

        {leads.length > 0 && draftCount === 0 && busy !== "draft" && (
          <p className="pt-2 text-center text-xs text-neutral-500">
            No messages drafted yet. Use &ldquo;Draft messages&rdquo; to write one per lead.
          </p>
        )}
      </div>
    </main>
  );
}
