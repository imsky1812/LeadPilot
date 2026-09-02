"use client";

import { useState } from "react";
import { LEAD_STATUSES } from "@/lib/schemas";
import type { LeadRow, LeadStatus, MessageRow } from "@/lib/types";

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  follow_up: "Follow-up",
  replied: "Replied",
};

const messageStatusStyles: Record<MessageRow["status"], string> = {
  draft: "bg-neutral-200 text-neutral-700",
  approved: "bg-emerald-50 text-emerald-700",
  sent: "bg-blue-50 text-blue-700",
};

/** Read `{ error, detail }` off a failed response without assuming it is JSON. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const json = await res.json();
    return json?.detail ?? json?.error ?? fallback;
  } catch {
    return `${fallback} (HTTP ${res.status})`;
  }
}

export function LeadCard({
  lead,
  message,
  today,
  onLeadChange,
  onMessageChange,
}: {
  lead: LeadRow;
  message: MessageRow | null;
  /** Local-calendar YYYY-MM-DD, used to flag an overdue follow-up. */
  today: string;
  onLeadChange: (l: LeadRow) => void;
  onMessageChange: (m: MessageRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The date input is kept in local state and only written on blur. Bound
  // directly to onChange it would fire a PATCH for every intermediate value the
  // browser reports while a date is being typed — including the empty string,
  // which would silently clear a follow-up the user was in the middle of
  // setting.
  const persisted = lead.follow_up_at ?? "";
  const [followUp, setFollowUp] = useState(persisted);
  const [followUpSource, setFollowUpSource] = useState(persisted);
  if (followUpSource !== persisted) {
    // The row changed underneath us (a resync, or another edit). Adopt it.
    setFollowUpSource(persisted);
    setFollowUp(persisted);
  }

  const overdue = !!lead.follow_up_at && lead.follow_up_at < today;
  const sources = lead.sources ?? [];

  async function patchLead(patch: { status?: LeadStatus; follow_up_at?: string | null }) {
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        // The controlled inputs re-render from the unchanged row, so the value
        // snaps back on its own; all that is missing is telling the user why.
        setError(await readError(res, "Could not update this lead"));
        return;
      }
      onLeadChange((await res.json()).lead as LeadRow);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function patchMessage(patch: { subject?: string; body?: string; status?: MessageRow["status"] }) {
    if (!message) return false;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/messages/${message.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setError(await readError(res, "Could not update this message"));
        return false;
      }
      onMessageChange((await res.json()).message as MessageRow);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function copyMessage() {
    if (!message) return;
    const text = message.subject ? `${message.subject}\n\n${message.body}` : message.body;
    try {
      // Absent outside a secure context, and it rejects when the document is
      // not focused — either way an unhandled rejection would be invisible.
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy — select the text and copy it manually.");
    }
  }

  return (
    <article className="rounded-lg border border-neutral-200 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-medium text-neutral-900">
            {lead.company_domain ? (
              <a
                href={`https://${lead.company_domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900"
              >
                {lead.company_name}
              </a>
            ) : (
              lead.company_name
            )}
            {!lead.sourced && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">
                Simulated
              </span>
            )}
          </h2>
          <p className="text-sm text-neutral-600">
            {[
              lead.contact_name ? `${lead.contact_name} · ${lead.contact_role}` : lead.contact_role,
              lead.location,
              lead.fit_score !== null ? `fit ${lead.fit_score}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        <label className="sr-only" htmlFor={`status-${lead.id}`}>
          Status for {lead.company_name}
        </label>
        <select
          id={`status-${lead.id}`}
          value={lead.status}
          onChange={(e) => patchLead({ status: e.target.value as LeadStatus })}
          className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs"
        >
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <p className="mt-3 text-sm text-neutral-700">{lead.fit_reason}</p>

      {sources.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {sources.map((s, i) => (
            <li key={`${s.url}-${i}`}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-700 underline"
              >
                {s.title || s.url}
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-neutral-600">
        <label htmlFor={`fu-${lead.id}`}>Follow up</label>
        <input
          id={`fu-${lead.id}`}
          type="date"
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          onBlur={() => {
            if (followUp === persisted) return;
            patchLead({ follow_up_at: followUp || null });
          }}
          className="rounded-md border border-neutral-300 px-2 py-1"
        />
        {overdue && <span className="font-medium text-red-700">overdue</span>}
      </div>

      {error && <p className="mt-3 text-xs text-red-700">{error}</p>}

      {!message ? (
        <p className="mt-4 rounded-md border border-dashed border-neutral-200 px-3 py-2 text-xs text-neutral-500">
          No draft yet.
        </p>
      ) : (
        <div className="mt-4 rounded-md bg-neutral-50 p-4">
          {editing ? (
            <>
              <label className="sr-only" htmlFor={`subject-${lead.id}`}>
                Subject
              </label>
              <input
                id={`subject-${lead.id}`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                className="mb-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
              <label className="sr-only" htmlFor={`body-${lead.id}`}>
                Message body
              </label>
              <textarea
                id={`body-${lead.id}`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    // Only leave edit mode if the write actually landed —
                    // otherwise the user's text would vanish on a failed save.
                    if (await patchMessage({ subject, body })) setEditing(false);
                  }}
                  className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-xs"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-neutral-900">
                  {message.subject || <span className="text-neutral-500">(no subject)</span>}
                </p>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${messageStatusStyles[message.status] ?? messageStatusStyles.draft}`}
                >
                  {message.status}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-700">{message.body}</p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSubject(message.subject ?? "");
                    setBody(message.body);
                    setEditing(true);
                  }}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-xs"
                >
                  Edit
                </button>

                {message.status === "draft" && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => patchMessage({ status: "approved" })}
                    className="rounded-md bg-emerald-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Approve
                  </button>
                )}

                {message.status === "approved" && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => patchMessage({ status: "sent" })}
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs"
                  >
                    Mark sent
                  </button>
                )}

                <button
                  type="button"
                  onClick={copyMessage}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-xs"
                >
                  {copied ? "Copied" : "Copy"}
                </button>

                {message.is_edited && <span className="text-xs text-neutral-500">edited</span>}
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}
