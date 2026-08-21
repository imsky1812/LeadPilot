# LeadPilot — Design Spec

**Date:** 2026-08-21
**Status:** Approved
**Repo:** https://github.com/imsky1812/LeadPilot.git

## 1. Overview

LeadPilot is an agentic sales outreach tool. A user describes a product or pastes a
seller catalog. A research agent produces a list of plausible target leads. A writing
agent drafts a personalized outreach message for each lead. The user reviews, edits,
approves, tracks status, and sets follow-up dates.

The priority is a working vertical slice that demos end to end, not feature breadth.

### Goals

- End-to-end demoable flow: catalog in, reviewed and approved drafts out.
- Agent calls that fail loudly and recoverably, never silently.
- Honest labeling: a lead grounded in web search is visually distinct from one the
  model invented.
- Deploys to Vercel as a single Next.js app.

### Non-goals (v1)

- Sending email. Approving a draft marks it approved and offers copy-to-clipboard.
- Authentication or multi-tenancy.
- Automated follow-up execution (cron, sequences, reminders). Follow-ups are dates
  and a filtered view, nothing more.
- CRM integrations, lead enrichment APIs, deliverability tooling.

## 2. Stack

| Concern | Choice | Note |
| --- | --- | --- |
| Framework | Next.js (App Router) + TypeScript | Single deployable; no separate FastAPI service |
| Styling | Tailwind CSS | |
| Database | Supabase Postgres | Dedicated `leadpilot` project, `ap-south-1` |
| Agent | Anthropic Claude API, `claude-opus-5` | Adaptive thinking |
| Validation | Zod + `zodOutputFormat` | Single source of truth for agent output |
| Tests | Vitest | Fixture-driven; no live API calls in CI |
| Hosting | Vercel | |

Rejected: a separate FastAPI backend. It adds a deployment target and a network hop
without buying anything here — every server-side need is met by route handlers.

## 3. Architecture

```
app/
  page.tsx                                  dashboard — campaigns + status rollup
  campaigns/new/page.tsx                    catalog input form
  campaigns/[id]/page.tsx                   lead table, drafts, follow-ups
  api/campaigns/route.ts                    POST create, GET list
  api/campaigns/[id]/route.ts               GET one (campaign + leads + messages)
  api/campaigns/[id]/research/route.ts      POST — SSE stream
  api/campaigns/[id]/draft/route.ts         POST — batch draft
  api/leads/[id]/route.ts                   PATCH status / follow_up_at
  api/messages/[id]/route.ts                PATCH subject / body / status
lib/
  anthropic.ts                              client + model constants
  agents/research.ts                        two-stage research agent
  agents/draft.ts                           per-lead message writer
  schemas.ts                                Zod schemas for all agent output
  db.ts                                     Supabase server client (service role)
  errors.ts                                 typed Anthropic error -> HTTP status
```

The Anthropic key and the Supabase service-role key are server-only. No Supabase
client is constructed in the browser; the UI talks only to the route handlers above.

## 4. Data model

All tables live in `public`. RLS is **enabled on every table with no policies**, so
the anon/publishable key can read nothing even if it is exposed. Route handlers use
the service-role key, which bypasses RLS.

```sql
create table campaigns (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  product_name        text not null,
  product_description text not null,
  target_market       text not null,
  extra_context       text,
  research_mode       text not null default 'simulated'
                        check (research_mode in ('simulated','web')),
  lead_count          int not null default 10 check (lead_count between 1 and 25),
  status              text not null default 'draft'
                        check (status in ('draft','researching','ready','failed')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table leads (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references campaigns(id) on delete cascade,
  company_name   text not null,
  company_domain text,
  contact_name   text,
  contact_role   text not null,
  location       text,
  fit_reason     text not null,
  fit_score      int check (fit_score between 0 and 100),
  sourced        boolean not null default false,
  sources        jsonb not null default '[]'::jsonb,
  status         text not null default 'new'
                   check (status in ('new','contacted','follow_up','replied')),
  follow_up_at   date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table messages (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  channel     text not null default 'email',
  subject     text,
  body        text not null,
  status      text not null default 'draft'
                check (status in ('draft','approved','sent')),
  is_edited   boolean not null default false,
  model       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table agent_runs (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid references campaigns(id) on delete cascade,
  kind          text not null check (kind in ('research','draft')),
  status        text not null check (status in ('running','succeeded','failed')),
  error         text,
  input_tokens  int,
  output_tokens int,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index leads_campaign_id_idx    on leads(campaign_id);
create index leads_follow_up_at_idx   on leads(follow_up_at) where follow_up_at is not null;
create index messages_lead_id_idx     on messages(lead_id);
create index messages_campaign_id_idx on messages(campaign_id);
create index agent_runs_campaign_idx  on agent_runs(campaign_id);
```

`messages.campaign_id` is denormalized so the dashboard can roll up draft counts per
campaign without joining through `leads`.

`sourced` and `sources` carry the honesty requirement. A lead with `sourced = false`
renders with a **Simulated** badge; a lead with `sourced = true` renders its citation
links. The distinction is stored per lead, not per campaign, because a single web-mode
run can legitimately return a mix.

`agent_runs` exists to make failures diagnosable — the difference between "it broke"
and "it broke with a 429 at 14:02". It is written by both agent endpoints and is not
read by any user-facing feature in v1 beyond a per-campaign "last run" indicator.

## 5. Agents

Both agents live in `lib/agents/` as plain async functions. They take typed input,
return typed output or throw, and know nothing about HTTP or Supabase. Route handlers
own persistence and streaming. This keeps the agents unit-testable without a database.

### 5.1 Research agent — two stages

Structured outputs (`output_config.format`) and web search do not compose: search
results attach citations to text blocks, and citations return a 400 when combined with
`output_config.format`. A single "search the web and return JSON" call is therefore
unreliable. The agent is split:

**Stage 1 — gather (skipped when `research_mode = 'simulated'`).**
One `client.messages.create` with the `web_search_20260209` server tool, `max_uses: 8`,
streamed. Output is prose research notes citing URLs.

- `stop_reason === 'pause_turn'` **must** be handled by pushing the paused assistant
  turn back and continuing. Unhandled, a long search turn ends silently and looks like
  "the agent found nothing" — no error is raised.
- Web-search failures return HTTP 200 with a `web_search_tool_result` block whose
  `content` is an error **object**, where success is an **array**. Branch on that
  before indexing.

**Stage 2 — structure (always runs).**
`client.messages.parse` with `zodOutputFormat(LeadsSchema)`. Input is the campaign
catalog plus, when present, the stage-1 notes.

- `parsed_output` is `null` when parsing fails. Guard explicitly and retry once with a
  corrective instruction; on a second failure, fail the run with the raw text recorded
  in `agent_runs.error`. Never assert with `!`.
- `sourced` is set to `true` only for leads that carry at least one source URL from
  stage 1. Simulated mode always yields `sourced = false`.

The agent targets `campaigns.lead_count` leads (default 10, capped at 25 — the cap keeps
a single run inside the function timeout and bounds token spend). Returning fewer is
acceptable and not an error; returning more is truncated to the requested count.

Effort: `high`. Thinking: adaptive.

### 5.2 Draft agent

One `client.messages.parse` per lead against `DraftSchema`, grounded in the campaign
catalog plus that lead's row. No search.

- Concurrency 3 across the batch, so a 20-lead campaign does not trip rate limits.
- Per-lead failures are isolated: a failed draft is recorded and skipped, and the batch
  reports partial success rather than failing wholesale.
- Effort: `medium` — this is a bounded writing task, not a reasoning one.

### 5.3 Zod schemas (`lib/schemas.ts`)

```ts
LeadSchema = {
  company_name: string,
  company_domain: string | null,
  contact_name: string | null,
  contact_role: string,
  location: string | null,
  fit_reason: string,
  fit_score: number,          // 0-100
  sources: { title: string, url: string }[],
}
LeadsSchema = { leads: LeadSchema[] }

DraftSchema = {
  subject: string,
  body: string,
  personalization_note: string,   // what the message hooked on; shown in review UI
}
```

The Zod schemas are the contract. The DB `check` constraints mirror them; any drift is
a bug.

## 6. API contracts

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/campaigns` | POST | Validate body with Zod, insert campaign, return it |
| `/api/campaigns` | GET | List campaigns with lead/draft counts and status rollup |
| `/api/campaigns/[id]` | GET | Campaign with its leads and their messages |
| `/api/campaigns/[id]/research` | POST | SSE stream; sets `status='researching'`, emits progress, inserts leads, sets `status='ready'` or `'failed'` |
| `/api/campaigns/[id]/draft` | POST | Body `{ lead_ids?: string[] }`. Omitted: drafts only for leads with no message yet. Provided: regenerates for exactly those leads, replacing any existing `draft` message but never one already `approved`. Returns per-lead results |
| `/api/leads/[id]` | PATCH | `status`, `follow_up_at` |
| `/api/messages/[id]` | PATCH | `subject`, `body` (sets `is_edited`), `status` |

Research streams for two reasons: it keeps the connection alive under Vercel's function
timeout (`export const maxDuration = 300`), and it gives the UI genuine progress rather
than a spinner. SSE event types: `progress` (human-readable string), `lead` (one
inserted lead), `done`, `error`.

## 7. Error handling

`lib/errors.ts` maps typed SDK exceptions most-specific-first:

| Exception | HTTP | User-facing message |
| --- | --- | --- |
| `Anthropic.BadRequestError` | 400 | Request rejected by the API |
| `Anthropic.AuthenticationError` | 500 | Check `ANTHROPIC_API_KEY` |
| `Anthropic.RateLimitError` | 429 | Rate limited; includes retry-after |
| `Anthropic.APIError` | `error.status` | Generic API failure |

Never string-match error messages.

Two failure modes do **not** throw and need explicit checks:

1. `stop_reason === 'refusal'` — HTTP 200. Read `stop_details.category` and surface it
   to the user; do not swallow it as an empty result.
2. Web-search tool-result errors — HTTP 200 with an error object in place of the
   results array, as described in 5.1.

Every agent endpoint writes an `agent_runs` row before starting and updates it on
completion or failure, including token usage.

## 8. Testing

Vitest, fixture-driven, no network in CI. The valuable boundary is parse/validate:

- Valid `LeadsSchema` payload parses and maps to DB rows.
- Malformed payload (`parsed_output === null`) triggers exactly one retry, then fails.
- A `pause_turn` response resumes rather than terminating the run.
- A web-search error **object** is detected and not indexed as an array.
- `sourced` is `true` only when a lead carries source URLs.
- Draft batch: one lead failing does not fail the other two.

TDD applies during implementation — test first for each of the above.

## 9. Environment

```
ANTHROPIC_API_KEY
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

`.env.local` is gitignored. `.env.example` is committed with these keys and empty
values. The service-role key is never referenced from a client component.

## 10. Build order

Each step ships working before the next begins.

1. Scaffold Next.js + TypeScript + Tailwind; create the Supabase project; apply the
   schema migration; commit `CLAUDE.md` and `.env.example`.
2. Catalog input form and campaign creation (`/campaigns/new`, `POST /api/campaigns`).
3. Research agent endpoint with SSE streaming and both modes.
4. Draft agent endpoint.
5. Review dashboard: lead table, draft previews, inline edit, approve, status tracking.
6. Follow-up scheduling: date picker on a lead, "due this week" filtered view.

## 11. CLAUDE.md

A short `CLAUDE.md` at the repo root points at this spec and records only what does not
belong in the spec: the dev/test/migrate commands, the env var names, the rule that the
Anthropic and service-role keys are server-only, and the model/effort conventions. It
is deliberately brief — long CLAUDE.md files drift out of date faster than they help.

## 12. Assumptions

- Single user, no auth. The deployed URL is effectively public; acceptable for a demo,
  and noted here so it is a decision rather than an oversight.
- Vercel Fluid compute is available for `maxDuration = 300`. If not, research runs fall
  back to the 60s default, which is tight for web mode but sufficient for simulated.
- Lead contact names are model-generated and may not correspond to real people.
  `contact_role` is the reliable field; `contact_name` is a suggestion. The UI must not
  present generated contact names as verified.
