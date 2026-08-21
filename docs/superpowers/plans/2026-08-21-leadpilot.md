# LeadPilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an agentic sales outreach tool that takes a product catalog, researches target leads, drafts personalized outreach per lead, and lets a user review, approve, and schedule follow-ups.

**Architecture:** A single Next.js App Router app. Agent logic lives in pure, dependency-injected functions under `lib/agents/` that know nothing about HTTP or the database; route handlers own persistence and streaming. The research agent is deliberately split into two Claude calls — a web-search call returning prose, then a `messages.parse` call returning schema-validated JSON — because structured outputs and search citations do not compose in one request.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Tailwind CSS, Supabase Postgres, `@anthropic-ai/sdk` (`claude-opus-5`), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-leadpilot-design.md`

## Global Constraints

- Model is `claude-opus-5` everywhere. Never a date-suffixed variant.
- Thinking is `{ type: "adaptive" }`. Never `budget_tokens` — it returns 400 on Opus 5.
- Effort: `high` for research, `medium` for drafting. Set via `output_config.effort`.
- `ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are server-only. Never imported into a file carrying `"use client"`.
- Never assert `parsed_output!`. It is `null` on parse failure and must be guarded.
- Never string-match error messages. Use `Anthropic.*Error` instance checks, most specific first.
- Agent functions take the Anthropic client as an injected final parameter so tests can pass a fake. No test makes a network call.
- Lead status values are exactly `new | contacted | follow_up | replied`.
- Commit after every task.

---

### Task 1: Scaffold, tooling, database

**Files:**
- Create: the Next.js app at repo root, `.env.example`, `CLAUDE.md`, `vitest.config.ts`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: a running dev server; a Supabase project whose four tables match the spec; `npm test` wired to Vitest

- [ ] **Step 1: Scaffold the app**

Run in `D:\PROjects\LeadPilot`. The directory already contains `.git`, `.gitignore`, and `docs/`, so scaffold in place:

```bash
npx create-next-app@latest . --typescript --tailwind --app --eslint --src-dir=false --import-alias "@/*" --no-turbopack --yes
```

If it refuses because the directory is non-empty, scaffold into a temp dir and move the files in — do not delete `docs/` or `.git/`.

- [ ] **Step 2: Install runtime and test dependencies**

```bash
npm install @anthropic-ai/sdk @supabase/supabase-js zod
npm install -D vitest @vitejs/plugin-react vite-tsconfig-paths
```

- [ ] **Step 3: Configure Vitest**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Verify the scaffold runs**

Run: `npm run build`
Expected: build succeeds with no type errors.

Run: `npm test`
Expected: exits 0 with "No test files found" — this is fine, it proves Vitest is wired.

- [ ] **Step 5: Create the Supabase project**

Use the Supabase connector. Organization `rilqffpxgrksuprlnbqm`, name `leadpilot`, region `ap-south-1`. Cost is $0/month — confirm the cost, then create. Poll `get_project` until status is `ACTIVE_HEALTHY` (takes a few minutes).

- [ ] **Step 6: Apply the schema migration**

Apply as migration name `init_leadpilot_schema`. This is the spec's schema verbatim:

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

alter table campaigns  enable row level security;
alter table leads      enable row level security;
alter table messages   enable row level security;
alter table agent_runs enable row level security;
```

No RLS policies are created. That is deliberate — the anon key can then read nothing, and every server route uses the service-role key, which bypasses RLS.

- [ ] **Step 7: Verify the schema landed**

Use the connector's `list_tables` with `verbose: true` on schema `public`. Expected: four tables, `leads.sources` typed `jsonb`, `campaigns.lead_count` present, RLS enabled on all four.

- [ ] **Step 8: Write `.env.example` and `.env.local`**

`.env.example` (committed):

```
ANTHROPIC_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Create `.env.local` (gitignored) with the real project URL from the connector. Ask the user for `ANTHROPIC_API_KEY` and the service-role key — the connector does not expose the service-role key, so the user must copy it from Supabase dashboard → Project Settings → API.

- [ ] **Step 9: Write `CLAUDE.md`**

```markdown
# LeadPilot

Agentic sales outreach: catalog in → researched leads → personalized drafts → review, approve, follow up.

**Design spec:** `docs/superpowers/specs/2026-08-21-leadpilot-design.md` — read it before changing agent or schema behavior.
**Implementation plan:** `docs/superpowers/plans/2026-08-21-leadpilot.md`

## Commands

- `npm run dev` — dev server
- `npm run build` — production build + type check
- `npm test` — Vitest (no network calls; agents take an injected client)

## Environment

`ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

**The Anthropic key and the service-role key are server-only.** Never import `lib/db.ts`,
`lib/anthropic.ts`, or anything under `lib/agents/` from a file with `"use client"`.

## Claude API conventions

- Model: `claude-opus-5`. Thinking: `{ type: "adaptive" }`. Never `budget_tokens` (400 on Opus 5).
- Effort via `output_config.effort` — `high` for research, `medium` for drafting.
- Structured output via `client.messages.parse` + `zodOutputFormat`. `parsed_output` is
  `null` on failure — always guard, never `!`.
- Structured outputs and web search do not compose (citations + `output_config.format`
  returns 400). That is why research is two calls, not one.
- Web search: `{ type: "web_search_20260209", name: "web_search" }`. Handle
  `stop_reason === "pause_turn"` by pushing the assistant turn back and continuing.
- Search failures arrive as HTTP 200 with an error *object* where success gives an
  *array*. Branch before indexing.

## Database

Supabase project `leadpilot` (`ap-south-1`). RLS enabled, no policies — server routes use
the service-role key. Schema changes go through a migration, never a hand-edit.
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app, Vitest, Supabase schema, CLAUDE.md"
```

---

### Task 2: Zod schemas

**Files:**
- Create: `lib/schemas.ts`, `lib/schemas.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `LeadSchema`, `LeadsSchema`, `DraftSchema`, `CreateCampaignSchema`, `UpdateLeadSchema`, `UpdateMessageSchema`, and inferred types `Lead`, `Draft`, `CreateCampaignInput`. Every later task imports from here.

- [ ] **Step 1: Write the failing test**

Create `lib/schemas.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { LeadsSchema, DraftSchema, CreateCampaignSchema } from "./schemas";

describe("LeadsSchema", () => {
  it("accepts a well-formed lead", () => {
    const parsed = LeadsSchema.parse({
      leads: [
        {
          company_name: "Northwind Logistics",
          company_domain: "northwind.example",
          contact_name: null,
          contact_role: "VP of Operations",
          location: "Rotterdam, NL",
          fit_reason: "Runs a cold chain fleet and publicly posts about route waste.",
          fit_score: 82,
          sources: [{ title: "Northwind about page", url: "https://northwind.example/about" }],
        },
      ],
    });
    expect(parsed.leads[0].company_name).toBe("Northwind Logistics");
    expect(parsed.leads[0].sources).toHaveLength(1);
  });

  it("rejects a fit_score above 100", () => {
    expect(() =>
      LeadsSchema.parse({
        leads: [
          {
            company_name: "X",
            company_domain: null,
            contact_name: null,
            contact_role: "CTO",
            location: null,
            fit_reason: "reason",
            fit_score: 140,
            sources: [],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("DraftSchema", () => {
  it("requires subject, body and personalization_note", () => {
    expect(() => DraftSchema.parse({ subject: "Hi", body: "Hello" })).toThrow();
  });
});

describe("CreateCampaignSchema", () => {
  it("defaults research_mode to simulated and lead_count to 10", () => {
    const parsed = CreateCampaignSchema.parse({
      name: "Q3 cold chain",
      product_name: "RouteIQ",
      product_description: "Route optimization for refrigerated fleets.",
      target_market: "Mid-size European cold chain logistics operators",
    });
    expect(parsed.research_mode).toBe("simulated");
    expect(parsed.lead_count).toBe(10);
  });

  it("rejects lead_count above 25", () => {
    expect(() =>
      CreateCampaignSchema.parse({
        name: "n",
        product_name: "p",
        product_description: "d",
        target_market: "t",
        lead_count: 99,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/schemas.test.ts`
Expected: FAIL — cannot resolve `./schemas`.

- [ ] **Step 3: Write the implementation**

Create `lib/schemas.ts`:

```typescript
import { z } from "zod";

export const SourceSchema = z.object({
  title: z.string(),
  url: z.string(),
});

export const LeadSchema = z.object({
  company_name: z.string(),
  company_domain: z.string().nullable(),
  contact_name: z.string().nullable(),
  contact_role: z.string(),
  location: z.string().nullable(),
  fit_reason: z.string(),
  fit_score: z.number().int().min(0).max(100),
  sources: z.array(SourceSchema),
});

export const LeadsSchema = z.object({
  leads: z.array(LeadSchema),
});

export const DraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  personalization_note: z.string(),
});

export const RESEARCH_MODES = ["simulated", "web"] as const;
export const LEAD_STATUSES = ["new", "contacted", "follow_up", "replied"] as const;
export const MESSAGE_STATUSES = ["draft", "approved", "sent"] as const;

export const CreateCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  product_name: z.string().min(1).max(200),
  product_description: z.string().min(1).max(5000),
  target_market: z.string().min(1).max(2000),
  extra_context: z.string().max(20000).optional(),
  research_mode: z.enum(RESEARCH_MODES).default("simulated"),
  lead_count: z.number().int().min(1).max(25).default(10),
});

export const UpdateLeadSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    follow_up_at: z.string().date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const UpdateMessageSchema = z
  .object({
    subject: z.string().max(300).optional(),
    body: z.string().max(20000).optional(),
    status: z.enum(MESSAGE_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export type Lead = z.infer<typeof LeadSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;
export type ResearchMode = (typeof RESEARCH_MODES)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/schemas.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/schemas.ts lib/schemas.test.ts
git commit -m "feat: add Zod schemas for agent output and API input"
```

---

### Task 3: Typed error mapping

**Files:**
- Create: `lib/errors.ts`, `lib/errors.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `toErrorResponse(error: unknown): { status: number; body: { error: string; detail?: string } }` and `class AgentError extends Error` with a `.detail` field. Route handlers in Tasks 5, 9, 11 call `toErrorResponse` in their catch blocks.

- [ ] **Step 1: Write the failing test**

Create `lib/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { toErrorResponse, AgentError } from "./errors";

function makeApiError(Cls: any, status: number) {
  // The SDK error constructors take (status, error, message, headers).
  return new Cls(status, { type: "error" }, "boom", new Headers());
}

describe("toErrorResponse", () => {
  it("maps RateLimitError to 429", () => {
    const res = toErrorResponse(makeApiError(Anthropic.RateLimitError, 429));
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limit/i);
  });

  it("maps AuthenticationError to 500 and names the env var", () => {
    const res = toErrorResponse(makeApiError(Anthropic.AuthenticationError, 401));
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ANTHROPIC_API_KEY");
  });

  it("maps BadRequestError to 400", () => {
    const res = toErrorResponse(makeApiError(Anthropic.BadRequestError, 400));
    expect(res.status).toBe(400);
  });

  it("maps AgentError to 422 and keeps its detail", () => {
    const res = toErrorResponse(new AgentError("Model returned unparseable JSON", "raw text here"));
    expect(res.status).toBe(422);
    expect(res.body.detail).toBe("raw text here");
  });

  it("maps an unknown error to 500 without leaking the message", () => {
    const res = toErrorResponse(new Error("connection string postgres://user:pw@host"));
    expect(res.status).toBe(500);
    expect(res.body.error).not.toContain("postgres://");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/errors.test.ts`
Expected: FAIL — cannot resolve `./errors`.

- [ ] **Step 3: Write the implementation**

Create `lib/errors.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";

/** Raised when the model responds successfully but the output is unusable. */
export class AgentError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "AgentError";
    this.detail = detail;
  }
}

export interface ErrorResponse {
  status: number;
  body: { error: string; detail?: string };
}

/**
 * Map a thrown value to an HTTP status and a safe user-facing message.
 * Ordered most-specific first — never reorder these branches, and never
 * string-match on error messages.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof AgentError) {
    return { status: 422, body: { error: error.message, detail: error.detail } };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return {
      status: 500,
      body: { error: "Claude rejected the credentials. Check ANTHROPIC_API_KEY." },
    };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return {
      status: 429,
      body: { error: "Claude rate limit reached. Wait a moment and retry." },
    };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { status: 400, body: { error: "Claude rejected the request.", detail: error.message } };
  }
  if (error instanceof Anthropic.APIError) {
    return {
      status: error.status ?? 500,
      body: { error: "Claude API error.", detail: error.message },
    };
  }
  return { status: 500, body: { error: "Unexpected server error." } };
}
```

The unknown-error branch deliberately drops the message — an arbitrary thrown error may carry a connection string or key.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/errors.test.ts`
Expected: PASS, 5 tests.

If the SDK error constructor signature differs, fix the `makeApiError` helper in the test to match — the production code under test is unaffected.

- [ ] **Step 5: Commit**

```bash
git add lib/errors.ts lib/errors.test.ts
git commit -m "feat: map Anthropic SDK errors to safe HTTP responses"
```

---

### Task 4: Anthropic and Supabase clients

**Files:**
- Create: `lib/anthropic.ts`, `lib/db.ts`, `lib/types.ts`

**Interfaces:**
- Consumes: `lib/schemas.ts`
- Produces: `getAnthropic(): Anthropic`, `MODEL`, `getDb(): SupabaseClient`, and row types `CampaignRow`, `LeadRow`, `MessageRow`, `AgentRunRow`.

- [ ] **Step 1: Write `lib/anthropic.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

let client: Anthropic | null = null;

/** Server-only. Never import from a "use client" file. */
export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client ??= new Anthropic();
  return client;
}
```

- [ ] **Step 2: Write `lib/types.ts`**

```typescript
import type { LeadStatus, ResearchMode } from "./schemas";

export interface CampaignRow {
  id: string;
  name: string;
  product_name: string;
  product_description: string;
  target_market: string;
  extra_context: string | null;
  research_mode: ResearchMode;
  lead_count: number;
  status: "draft" | "researching" | "ready" | "failed";
  created_at: string;
  updated_at: string;
}

export interface LeadRow {
  id: string;
  campaign_id: string;
  company_name: string;
  company_domain: string | null;
  contact_name: string | null;
  contact_role: string;
  location: string | null;
  fit_reason: string;
  fit_score: number | null;
  sourced: boolean;
  sources: { title: string; url: string }[];
  status: LeadStatus;
  follow_up_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  channel: string;
  subject: string | null;
  body: string;
  status: "draft" | "approved" | "sent";
  is_edited: boolean;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRunRow {
  id: string;
  campaign_id: string | null;
  kind: "research" | "draft";
  status: "running" | "succeeded" | "failed";
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  finished_at: string | null;
}
```

- [ ] **Step 3: Write `lib/db.ts`**

```typescript
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let db: SupabaseClient | null = null;

/**
 * Server-only Supabase client using the service-role key, which bypasses RLS.
 * Never import this from a "use client" file.
 */
export function getDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  db ??= createClient(url, key, { auth: { persistSession: false } });
  return db;
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add lib/anthropic.ts lib/db.ts lib/types.ts
git commit -m "feat: add server-only Anthropic and Supabase clients"
```

---

### Task 5: Campaign creation — API and form

**Files:**
- Create: `app/api/campaigns/route.ts`, `app/campaigns/new/page.tsx`, `app/campaigns/new/form.tsx`

**Interfaces:**
- Consumes: `CreateCampaignSchema` (Task 2), `toErrorResponse` (Task 3), `getDb` (Task 4)
- Produces: `POST /api/campaigns` returning `{ campaign: CampaignRow }` with status 201; `GET /api/campaigns` returning `{ campaigns: CampaignSummary[] }` where `CampaignSummary = CampaignRow & { lead_count_actual: number; draft_count: number }`

- [ ] **Step 1: Write the route handler**

Create `app/api/campaigns/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { CreateCampaignSchema } from "@/lib/schemas";
import { getDb } from "@/lib/db";
import { toErrorResponse } from "@/lib/errors";

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const parsed = CreateCampaignSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid campaign", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    }

    const db = getDb();
    const { data, error } = await db.from("campaigns").insert(parsed.data).select().single();
    if (error) {
      return NextResponse.json({ error: "Could not create campaign", detail: error.message }, { status: 500 });
    }
    return NextResponse.json({ campaign: data }, { status: 201 });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}

export async function GET() {
  try {
    const db = getDb();
    const { data: campaigns, error } = await db
      .from("campaigns")
      .select("*, leads(count), messages(count)")
      .order("created_at", { ascending: false });
    if (error) {
      return NextResponse.json({ error: "Could not list campaigns", detail: error.message }, { status: 500 });
    }
    const shaped = (campaigns ?? []).map((c: any) => ({
      ...c,
      lead_count_actual: c.leads?.[0]?.count ?? 0,
      draft_count: c.messages?.[0]?.count ?? 0,
      leads: undefined,
      messages: undefined,
    }));
    return NextResponse.json({ campaigns: shaped });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
```

- [ ] **Step 2: Write the form client component**

Create `app/campaigns/new/form.tsx`. It must NOT import `lib/db.ts` or `lib/anthropic.ts`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewCampaignForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const fd = new FormData(e.currentTarget);
    const payload = {
      name: String(fd.get("name") ?? ""),
      product_name: String(fd.get("product_name") ?? ""),
      product_description: String(fd.get("product_description") ?? ""),
      target_market: String(fd.get("target_market") ?? ""),
      extra_context: String(fd.get("extra_context") ?? "") || undefined,
      research_mode: String(fd.get("research_mode") ?? "simulated"),
      lead_count: Number(fd.get("lead_count") ?? 10),
    };

    const res = await fetch("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    setPending(false);

    if (!res.ok) {
      setError(json.detail ?? json.error ?? "Something went wrong");
      return;
    }
    router.push(`/campaigns/${json.campaign.id}`);
  }

  const field = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
  const label = "block text-sm font-medium text-neutral-700 mb-1";

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label className={label} htmlFor="name">Campaign name</label>
        <input id="name" name="name" required className={field} placeholder="Q3 cold chain outreach" />
      </div>
      <div>
        <label className={label} htmlFor="product_name">Product name</label>
        <input id="product_name" name="product_name" required className={field} placeholder="RouteIQ" />
      </div>
      <div>
        <label className={label} htmlFor="product_description">Product description</label>
        <textarea id="product_description" name="product_description" required rows={4} className={field}
          placeholder="Route optimization for refrigerated fleets. Cuts spoilage by predicting thermal risk per leg." />
      </div>
      <div>
        <label className={label} htmlFor="target_market">Target market</label>
        <textarea id="target_market" name="target_market" required rows={2} className={field}
          placeholder="Mid-size European cold chain logistics operators, 50–500 vehicles" />
      </div>
      <div>
        <label className={label} htmlFor="extra_context">Catalog or extra context (optional)</label>
        <textarea id="extra_context" name="extra_context" rows={6} className={field}
          placeholder="Paste a product catalog, pricing sheet, or positioning notes." />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={label} htmlFor="research_mode">Research mode</label>
          <select id="research_mode" name="research_mode" className={field} defaultValue="simulated">
            <option value="simulated">Simulated — no web search</option>
            <option value="web">Web search — real companies</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="lead_count">Number of leads</label>
          <input id="lead_count" name="lead_count" type="number" min={1} max={25} defaultValue={10} className={field} />
        </div>
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <button type="submit" disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "Creating…" : "Create campaign"}
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Write the page**

Create `app/campaigns/new/page.tsx`:

```tsx
import { NewCampaignForm } from "./form";

export default function NewCampaignPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-neutral-900">New campaign</h1>
      <p className="mt-1 mb-8 text-sm text-neutral-600">
        Describe what you sell and who you sell it to. LeadPilot researches matching leads from this.
      </p>
      <NewCampaignForm />
    </main>
  );
}
```

- [ ] **Step 4: Verify end to end**

Run: `npm run dev`, open `http://localhost:3000/campaigns/new`, submit the form.
Expected: redirects to `/campaigns/<uuid>` (which 404s for now — that page arrives in Task 11). Confirm the row exists via the Supabase connector: `select id, name, research_mode, lead_count, status from campaigns;`

- [ ] **Step 5: Commit**

```bash
git add app/api/campaigns/route.ts app/campaigns/new
git commit -m "feat: campaign creation API and catalog input form"
```

---

### Task 6: Research agent — structuring stage

**Files:**
- Create: `lib/agents/research.ts`, `lib/agents/research.test.ts`

**Interfaces:**
- Consumes: `LeadsSchema`, `Lead` (Task 2); `AgentError` (Task 3); `MODEL` (Task 4)
- Produces:
  - `interface ResearchInput { product_name: string; product_description: string; target_market: string; extra_context?: string | null; lead_count: number }`
  - `structureLeads(input: ResearchInput, notes: string | null, client: Anthropic): Promise<{ leads: Lead[]; usage: Usage }>`
  - `interface Usage { input_tokens: number; output_tokens: number }`

This task builds stage 2 only. Stage 1 (web search) arrives in Task 7, which is why `notes` is already a parameter here and may be `null`.

- [ ] **Step 1: Write the failing test**

Create `lib/agents/research.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { structureLeads, type ResearchInput } from "./research";
import { AgentError } from "../errors";

const input: ResearchInput = {
  product_name: "RouteIQ",
  product_description: "Route optimization for refrigerated fleets.",
  target_market: "Mid-size European cold chain operators",
  extra_context: null,
  lead_count: 2,
};

function lead(over: Partial<any> = {}) {
  return {
    company_name: "Northwind Logistics",
    company_domain: "northwind.example",
    contact_name: null,
    contact_role: "VP Operations",
    location: "Rotterdam, NL",
    fit_reason: "Cold chain fleet with public route-waste commentary.",
    fit_score: 80,
    sources: [],
    ...over,
  };
}

function fakeClient(parse: any): Anthropic {
  return { messages: { parse } } as unknown as Anthropic;
}

describe("structureLeads", () => {
  it("returns parsed leads and usage", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { leads: [lead(), lead({ company_name: "Frostline" })] },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await structureLeads(input, null, fakeClient(parse));

    expect(result.leads).toHaveLength(2);
    expect(result.leads[0].company_name).toBe("Northwind Logistics");
    expect(result.usage.input_tokens).toBe(100);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("retries exactly once when parsed_output is null, then succeeds", async () => {
    const parse = vi
      .fn()
      .mockResolvedValueOnce({
        parsed_output: null,
        stop_reason: "end_turn",
        content: [{ type: "text", text: "here are some leads, not json" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        parsed_output: { leads: [lead()] },
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 8 },
      });

    const result = await structureLeads(input, null, fakeClient(parse));

    expect(parse).toHaveBeenCalledTimes(2);
    expect(result.leads).toHaveLength(1);
  });

  it("throws AgentError after a second parse failure, carrying the raw text", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: null,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "still not json" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await expect(structureLeads(input, null, fakeClient(parse))).rejects.toThrow(AgentError);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("throws AgentError on a refusal without retrying", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: null,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    await expect(structureLeads(input, null, fakeClient(parse))).rejects.toThrow(/declin|refus/i);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("truncates to lead_count when the model overshoots", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { leads: [lead(), lead(), lead(), lead()] },
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await structureLeads(input, null, fakeClient(parse));
    expect(result.leads).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/agents/research.test.ts`
Expected: FAIL — cannot resolve `./research`.

- [ ] **Step 3: Write the implementation**

Create `lib/agents/research.ts`:

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LeadsSchema, type Lead } from "../schemas";
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

function catalogBlock(input: ResearchInput): string {
  return [
    `Product: ${input.product_name}`,
    `Description: ${input.product_description}`,
    `Target market: ${input.target_market}`,
    input.extra_context ? `Additional catalog context:\n${input.extra_context}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function firstText(response: any): string {
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

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: any[] = [{ role: "user", content: userPrompt }];
    if (attempt === 1) {
      messages.push({
        role: "user",
        content:
          "Your previous response did not match the required schema. Return only data matching the schema exactly.",
      });
    }

    const response: any = await client.messages.parse({
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
  }

  throw new AgentError(
    "Claude returned research output that did not match the lead schema, twice.",
    "the model's raw text was not valid structured output",
  );
}
```

Note the retry loop runs at most twice and the refusal branch returns before a retry — both are asserted by the tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/agents/research.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/research.ts lib/agents/research.test.ts
git commit -m "feat: research agent structuring stage with guarded parse and single retry"
```

---

### Task 7: Research agent — web search stage

**Files:**
- Modify: `lib/agents/research.ts`, `lib/agents/research.test.ts`

**Interfaces:**
- Consumes: everything from Task 6
- Produces: `gatherResearchNotes(input: ResearchInput, client: Anthropic): Promise<{ notes: string; usage: Usage }>` and `researchLeads(input: ResearchInput, mode: ResearchMode, client: Anthropic, onProgress?: (msg: string) => void): Promise<{ leads: Lead[]; usage: Usage; sourced: boolean }>`

- [ ] **Step 1: Write the failing tests**

Append to `lib/agents/research.test.ts`:

```typescript
import { gatherResearchNotes, researchLeads } from "./research";

function searchResponse(over: Partial<any> = {}) {
  return {
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 40 },
    content: [
      {
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", title: "Northwind", url: "https://northwind.example" }],
      },
      { type: "text", text: "Northwind Logistics runs 200 reefer trucks in Rotterdam." },
    ],
    ...over,
  };
}

function fakeSearchClient(create: any): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

describe("gatherResearchNotes", () => {
  it("returns the text notes from a completed search", async () => {
    const create = vi.fn().mockResolvedValue(searchResponse());
    const result = await gatherResearchNotes(input, fakeSearchClient(create));
    expect(result.notes).toContain("Northwind Logistics");
    expect(create).toHaveBeenCalledOnce();
  });

  it("resumes a pause_turn instead of returning a truncated result", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        searchResponse({
          stop_reason: "pause_turn",
          content: [{ type: "text", text: "Searching…" }],
        }),
      )
      .mockResolvedValueOnce(searchResponse());

    const result = await gatherResearchNotes(input, fakeSearchClient(create));

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.notes).toContain("Northwind Logistics");
  });

  it("treats a search error object as an error, not an array to index", async () => {
    const create = vi.fn().mockResolvedValue(
      searchResponse({
        content: [
          { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
          { type: "text", text: "" },
        ],
      }),
    );

    await expect(gatherResearchNotes(input, fakeSearchClient(create))).rejects.toThrow(
      /max_uses_exceeded/,
    );
  });
});

describe("researchLeads", () => {
  it("skips search entirely in simulated mode and marks leads unsourced", async () => {
    const create = vi.fn();
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { leads: [lead({ sources: [] }), lead({ sources: [] })] },
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = { messages: { create, parse } } as unknown as Anthropic;

    const result = await researchLeads(input, "simulated", client);

    expect(create).not.toHaveBeenCalled();
    expect(result.sourced).toBe(false);
    expect(result.leads.every((l) => l.sources.length === 0)).toBe(true);
  });

  it("searches in web mode and reports sourced when leads carry source URLs", async () => {
    const create = vi.fn().mockResolvedValue(searchResponse());
    const parse = vi.fn().mockResolvedValue({
      parsed_output: {
        leads: [lead({ sources: [{ title: "Northwind", url: "https://northwind.example" }] })],
      },
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = { messages: { create, parse } } as unknown as Anthropic;

    const result = await researchLeads(input, "web", client);

    expect(create).toHaveBeenCalledOnce();
    expect(result.sourced).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- lib/agents/research.test.ts`
Expected: FAIL — `gatherResearchNotes` and `researchLeads` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/agents/research.ts` (add `ResearchMode` to the import from `../schemas`):

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all research tests plus the earlier suites.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/research.ts lib/agents/research.test.ts
git commit -m "feat: research web-search stage with pause_turn resume and search-error detection"
```

---

### Task 8: Research route handler with SSE

**Files:**
- Create: `app/api/campaigns/[id]/research/route.ts`, `lib/runs.ts`

**Interfaces:**
- Consumes: `researchLeads` (Task 7), `getDb` (Task 4), `toErrorResponse` (Task 3)
- Produces: `POST /api/campaigns/:id/research` streaming `text/event-stream` with event types `progress`, `lead`, `done`, `error`. Also `startRun`/`finishRun` from `lib/runs.ts`.

- [ ] **Step 1: Write `lib/runs.ts`**

```typescript
import { getDb } from "./db";

export async function startRun(campaignId: string, kind: "research" | "draft"): Promise<string | null> {
  const db = getDb();
  const { data } = await db
    .from("agent_runs")
    .insert({ campaign_id: campaignId, kind, status: "running" })
    .select("id")
    .single();
  return data?.id ?? null;
}

export async function finishRun(
  runId: string | null,
  status: "succeeded" | "failed",
  opts: { error?: string; input_tokens?: number; output_tokens?: number } = {},
): Promise<void> {
  if (!runId) return;
  const db = getDb();
  await db
    .from("agent_runs")
    .update({
      status,
      error: opts.error ?? null,
      input_tokens: opts.input_tokens ?? null,
      output_tokens: opts.output_tokens ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
}
```

- [ ] **Step 2: Write the route handler**

Create `app/api/campaigns/[id]/research/route.ts`:

```typescript
import { getDb } from "@/lib/db";
import { getAnthropic } from "@/lib/anthropic";
import { researchLeads, type ResearchInput } from "@/lib/agents/research";
import { toErrorResponse } from "@/lib/errors";
import { startRun, finishRun } from "@/lib/runs";
import type { CampaignRow } from "@/lib/types";

export const maxDuration = 300;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const { data: campaign, error } = await db.from("campaigns").select("*").eq("id", id).single();
  if (error || !campaign) {
    return Response.json({ error: "Campaign not found" }, { status: 404 });
  }
  const c = campaign as CampaignRow;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sse(event, data)));

      const runId = await startRun(c.id, "research");
      await db.from("campaigns").update({ status: "researching", updated_at: new Date().toISOString() }).eq("id", c.id);

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
          sourced: l.sources.length > 0,
          sources: l.sources,
        }));

        const { data: inserted, error: insertError } = await db.from("leads").insert(rows).select();
        if (insertError) throw new Error(insertError.message);

        for (const row of inserted ?? []) send("lead", row);

        await db.from("campaigns").update({ status: "ready", updated_at: new Date().toISOString() }).eq("id", c.id);
        await finishRun(runId, "succeeded", {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        });

        send("done", { count: inserted?.length ?? 0 });
      } catch (err) {
        const { body } = toErrorResponse(err);
        await db.from("campaigns").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", c.id);
        await finishRun(runId, "failed", { error: body.detail ?? body.error });
        send("error", body);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

The handler returns 200 with an `error` SSE event on agent failure rather than an HTTP error status — the stream has already begun, so the status line is long gone. The client reads the `error` event.

- [ ] **Step 3: Verify manually against a real campaign**

Run: `npm run dev`. Create a campaign in simulated mode via the form, then:

```bash
curl -N -X POST http://localhost:3000/api/campaigns/<campaign-id>/research
```

Expected: `progress` events, then a stream of `lead` events, then `done`. Confirm with the Supabase connector: `select company_name, sourced, fit_score from leads where campaign_id = '<id>';`

- [ ] **Step 4: Commit**

```bash
git add app/api/campaigns/\[id\]/research lib/runs.ts
git commit -m "feat: research endpoint streaming progress and leads over SSE"
```

---

### Task 9: Draft agent

**Files:**
- Create: `lib/agents/draft.ts`, `lib/agents/draft.test.ts`

**Interfaces:**
- Consumes: `DraftSchema`, `Draft` (Task 2); `AgentError` (Task 3); `MODEL` (Task 4); `LeadRow` (Task 4)
- Produces:
  - `interface DraftContext { product_name: string; product_description: string; target_market: string; extra_context?: string | null }`
  - `draftMessage(ctx: DraftContext, lead: LeadRow, client: Anthropic): Promise<{ draft: Draft; usage: Usage }>`
  - `draftBatch(ctx: DraftContext, leads: LeadRow[], client: Anthropic, concurrency?: number): Promise<DraftResult[]>` where `DraftResult = { lead_id: string; ok: true; draft: Draft } | { lead_id: string; ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

Create `lib/agents/draft.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { draftMessage, draftBatch, type DraftContext } from "./draft";
import type { LeadRow } from "../types";
import { AgentError } from "../errors";

const ctx: DraftContext = {
  product_name: "RouteIQ",
  product_description: "Route optimization for refrigerated fleets.",
  target_market: "Mid-size European cold chain operators",
  extra_context: null,
};

function leadRow(id: string, over: Partial<LeadRow> = {}): LeadRow {
  return {
    id,
    campaign_id: "c1",
    company_name: "Northwind Logistics",
    company_domain: "northwind.example",
    contact_name: null,
    contact_role: "VP Operations",
    location: "Rotterdam, NL",
    fit_reason: "Cold chain fleet with public route-waste commentary.",
    fit_score: 80,
    sourced: false,
    sources: [],
    status: "new",
    follow_up_at: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

const goodDraft = {
  parsed_output: {
    subject: "Cutting reefer spoilage at Northwind",
    body: "Hi there — noticed Northwind runs 200 reefer trucks…",
    personalization_note: "Hooked on their public route-waste commentary.",
  },
  stop_reason: "end_turn",
  usage: { input_tokens: 50, output_tokens: 30 },
};

describe("draftMessage", () => {
  it("returns a parsed draft", async () => {
    const parse = vi.fn().mockResolvedValue(goodDraft);
    const client = { messages: { parse } } as unknown as Anthropic;

    const { draft } = await draftMessage(ctx, leadRow("l1"), client);

    expect(draft.subject).toContain("Northwind");
    expect(draft.personalization_note).toBeTruthy();
  });

  it("throws AgentError when parsed_output is null", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: null,
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const client = { messages: { parse } } as unknown as Anthropic;

    await expect(draftMessage(ctx, leadRow("l1"), client)).rejects.toThrow(AgentError);
  });
});

describe("draftBatch", () => {
  it("isolates a single lead failure without failing the batch", async () => {
    const parse = vi.fn().mockImplementation((args: any) => {
      const prompt = JSON.stringify(args.messages);
      if (prompt.includes("Frostline")) return Promise.reject(new Error("boom"));
      return Promise.resolve(goodDraft);
    });
    const client = { messages: { parse } } as unknown as Anthropic;

    const results = await draftBatch(
      ctx,
      [leadRow("l1"), leadRow("l2", { company_name: "Frostline" }), leadRow("l3")],
      client,
      2,
    );

    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const failed = results.find((r) => !r.ok);
    expect(failed?.lead_id).toBe("l2");
  });

  it("respects the concurrency ceiling", async () => {
    let inFlight = 0;
    let peak = 0;
    const parse = vi.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return goodDraft;
    });
    const client = { messages: { parse } } as unknown as Anthropic;

    await draftBatch(ctx, [1, 2, 3, 4, 5, 6].map((n) => leadRow(`l${n}`)), client, 2);

    expect(peak).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/agents/draft.test.ts`
Expected: FAIL — cannot resolve `./draft`.

- [ ] **Step 3: Write the implementation**

Create `lib/agents/draft.ts`:

```typescript
import type Anthropic from "@anthropic-ai/sdk";
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
  | { lead_id: string; ok: true; draft: Draft }
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
        const { draft } = await draftMessage(ctx, lead, client);
        results[index] = { lead_id: lead.id, ok: true, draft };
      } catch (err) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/agents/draft.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/draft.ts lib/agents/draft.test.ts
git commit -m "feat: draft agent with bounded concurrency and isolated per-lead failures"
```

---

### Task 10: Draft route handler

**Files:**
- Create: `app/api/campaigns/[id]/draft/route.ts`

**Interfaces:**
- Consumes: `draftBatch` (Task 9), `getDb`, `startRun`/`finishRun` (Task 8)
- Produces: `POST /api/campaigns/:id/draft` accepting `{ lead_ids?: string[] }` and returning `{ drafted: number; failed: { lead_id: string; error: string }[] }`

- [ ] **Step 1: Write the route handler**

Create `app/api/campaigns/[id]/draft/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getAnthropic, MODEL } from "@/lib/anthropic";
import { draftBatch, type DraftContext } from "@/lib/agents/draft";
import { toErrorResponse } from "@/lib/errors";
import { startRun, finishRun } from "@/lib/runs";
import type { CampaignRow, LeadRow } from "@/lib/types";

export const maxDuration = 300;

const BodySchema = z.object({ lead_ids: z.array(z.string().uuid()).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  let runId: string | null = null;

  try {
    const raw = await req.json().catch(() => ({}));
    const parsedBody = BodySchema.safeParse(raw);
    if (!parsedBody.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { lead_ids } = parsedBody.data;

    const { data: campaign } = await db.from("campaigns").select("*").eq("id", id).single();
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    const c = campaign as CampaignRow;

    // Which leads to draft for.
    let query = db.from("leads").select("*").eq("campaign_id", id);
    if (lead_ids?.length) query = query.in("id", lead_ids);
    const { data: allLeads } = await query;
    let leads = (allLeads ?? []) as LeadRow[];

    const { data: existing } = await db
      .from("messages")
      .select("id, lead_id, status")
      .eq("campaign_id", id);
    const byLead = new Map((existing ?? []).map((m: any) => [m.lead_id, m]));

    if (lead_ids?.length) {
      // Explicit regeneration: skip leads whose message is already approved.
      leads = leads.filter((l) => byLead.get(l.id)?.status !== "approved");
    } else {
      // Default: only leads with no message at all.
      leads = leads.filter((l) => !byLead.has(l.id));
    }

    if (leads.length === 0) {
      return NextResponse.json({ drafted: 0, failed: [] });
    }

    runId = await startRun(c.id, "draft");

    const ctx: DraftContext = {
      product_name: c.product_name,
      product_description: c.product_description,
      target_market: c.target_market,
      extra_context: c.extra_context,
    };

    const results = await draftBatch(ctx, leads, getAnthropic());
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok).map((r) => ({ lead_id: r.lead_id, error: (r as any).error }));

    // Replace any existing non-approved draft for these leads.
    const regenIds = succeeded.map((r) => r.lead_id).filter((lid) => byLead.has(lid));
    if (regenIds.length) {
      await db.from("messages").delete().in("lead_id", regenIds).eq("status", "draft");
    }

    if (succeeded.length) {
      const rows = succeeded.map((r: any) => ({
        lead_id: r.lead_id,
        campaign_id: c.id,
        subject: r.draft.subject,
        body: r.draft.body,
        model: MODEL,
      }));
      const { error: insertError } = await db.from("messages").insert(rows);
      if (insertError) throw new Error(insertError.message);
    }

    await finishRun(runId, failed.length && !succeeded.length ? "failed" : "succeeded", {
      error: failed.length ? `${failed.length} lead(s) failed` : undefined,
    });

    return NextResponse.json({ drafted: succeeded.length, failed });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    await finishRun(runId, "failed", { error: body.detail ?? body.error });
    return NextResponse.json(body, { status });
  }
}
```

`personalization_note` is intentionally not persisted — the schema has no column for it, and it exists to steer the model toward specificity. If it should be shown in the review UI, that needs a migration; leave it out of v1.

- [ ] **Step 2: Verify manually**

With a campaign that already has leads:

```bash
curl -X POST http://localhost:3000/api/campaigns/<id>/draft -H "Content-Type: application/json" -d '{}'
```

Expected: `{"drafted":N,"failed":[]}`. Run it a second time — expected `{"drafted":0,"failed":[]}`, proving it does not re-draft.

- [ ] **Step 3: Commit**

```bash
git add app/api/campaigns/\[id\]/draft
git commit -m "feat: draft endpoint with regeneration guard and approved-message protection"
```

---

### Task 11: Lead and message mutation endpoints

**Files:**
- Create: `app/api/leads/[id]/route.ts`, `app/api/messages/[id]/route.ts`, `app/api/campaigns/[id]/route.ts`

**Interfaces:**
- Consumes: `UpdateLeadSchema`, `UpdateMessageSchema` (Task 2), `getDb` (Task 4)
- Produces: `PATCH /api/leads/:id` → `{ lead: LeadRow }`; `PATCH /api/messages/:id` → `{ message: MessageRow }`; `GET /api/campaigns/:id` → `{ campaign, leads, messages }`

- [ ] **Step 1: Write `app/api/campaigns/[id]/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const { data: campaign } = await db.from("campaigns").select("*").eq("id", id).single();
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  const { data: leads } = await db
    .from("leads")
    .select("*")
    .eq("campaign_id", id)
    .order("fit_score", { ascending: false, nullsFirst: false });

  const { data: messages } = await db.from("messages").select("*").eq("campaign_id", id);

  return NextResponse.json({ campaign, leads: leads ?? [], messages: messages ?? [] });
}
```

- [ ] **Step 2: Write `app/api/leads/[id]/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { UpdateLeadSchema } from "@/lib/schemas";
import { getDb } from "@/lib/db";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = UpdateLeadSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update", detail: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const db = getDb();
  const { data, error } = await db
    .from("leads")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: "Could not update lead", detail: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  return NextResponse.json({ lead: data });
}
```

- [ ] **Step 3: Write `app/api/messages/[id]/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { UpdateMessageSchema } from "@/lib/schemas";
import { getDb } from "@/lib/db";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = UpdateMessageSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update", detail: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const update: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  // Editing the text marks the message as human-edited; a pure status change does not.
  if (parsed.data.subject !== undefined || parsed.data.body !== undefined) {
    update.is_edited = true;
  }

  const db = getDb();
  const { data, error } = await db.from("messages").update(update).eq("id", id).select().single();

  if (error) return NextResponse.json({ error: "Could not update message", detail: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Message not found" }, { status: 404 });
  return NextResponse.json({ message: data });
}
```

- [ ] **Step 4: Verify manually**

```bash
curl -X PATCH http://localhost:3000/api/leads/<lead-id> -H "Content-Type: application/json" -d '{"status":"contacted"}'
curl -X PATCH http://localhost:3000/api/messages/<msg-id> -H "Content-Type: application/json" -d '{"body":"edited"}'
```

Expected: both return the updated row; the message now has `is_edited: true`.

- [ ] **Step 5: Commit**

```bash
git add app/api/leads app/api/messages app/api/campaigns/\[id\]/route.ts
git commit -m "feat: lead and message mutation endpoints"
```

---

### Task 12: Campaign detail — review dashboard

**Files:**
- Create: `app/campaigns/[id]/page.tsx`, `app/campaigns/[id]/campaign-view.tsx`, `app/campaigns/[id]/lead-card.tsx`

**Interfaces:**
- Consumes: `GET /api/campaigns/:id`, the research SSE endpoint, the draft endpoint, both PATCH endpoints
- Produces: the reviewable UI. No later task depends on its internals.

- [ ] **Step 1: Write the server page**

Create `app/campaigns/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import type { CampaignRow, LeadRow, MessageRow } from "@/lib/types";
import { CampaignView } from "./campaign-view";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const { data: campaign } = await db.from("campaigns").select("*").eq("id", id).single();
  if (!campaign) notFound();

  const { data: leads } = await db
    .from("leads")
    .select("*")
    .eq("campaign_id", id)
    .order("fit_score", { ascending: false, nullsFirst: false });
  const { data: messages } = await db.from("messages").select("*").eq("campaign_id", id);

  return (
    <CampaignView
      campaign={campaign as CampaignRow}
      initialLeads={(leads ?? []) as LeadRow[]}
      initialMessages={(messages ?? []) as MessageRow[]}
    />
  );
}
```

- [ ] **Step 2: Write the client view**

Create `app/campaigns/[id]/campaign-view.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { CampaignRow, LeadRow, MessageRow } from "@/lib/types";
import { LeadCard } from "./lead-card";

type Filter = "all" | "new" | "contacted" | "follow_up" | "replied" | "due";

export function CampaignView({
  campaign,
  initialLeads,
  initialMessages,
}: {
  campaign: CampaignRow;
  initialLeads: LeadRow[];
  initialMessages: MessageRow[];
}) {
  const [leads, setLeads] = useState(initialLeads);
  const [messages, setMessages] = useState(initialMessages);
  const [progress, setProgress] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | "research" | "draft">(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const messageByLead = new Map(messages.map((m) => [m.lead_id, m]));

  async function runResearch() {
    setBusy("research");
    setError(null);
    setProgress([]);
    setLeads([]);

    const res = await fetch(`/api/campaigns/${campaign.id}/research`, { method: "POST" });
    if (!res.body) {
      setError("No response stream");
      setBusy(null);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!eventLine || !dataLine) continue;

        const event = eventLine.slice(7).trim();
        const data = JSON.parse(dataLine.slice(6));

        if (event === "progress") setProgress((p) => [...p, data.message]);
        if (event === "lead") setLeads((l) => [...l, data as LeadRow]);
        if (event === "error") setError(data.detail ?? data.error);
        if (event === "done") setProgress((p) => [...p, `Found ${data.count} leads.`]);
      }
    }
    setBusy(null);
  }

  async function runDrafts() {
    setBusy("draft");
    setError(null);
    const res = await fetch(`/api/campaigns/${campaign.id}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    if (!res.ok) setError(json.detail ?? json.error);
    else {
      const refreshed = await fetch(`/api/campaigns/${campaign.id}`).then((r) => r.json());
      setMessages(refreshed.messages);
      if (json.failed?.length) setError(`${json.failed.length} lead(s) could not be drafted.`);
    }
    setBusy(null);
  }

  function onLeadChange(updated: LeadRow) {
    setLeads((ls) => ls.map((l) => (l.id === updated.id ? updated : l)));
  }
  function onMessageChange(updated: MessageRow) {
    setMessages((ms) => ms.map((m) => (m.id === updated.id ? updated : m)));
  }

  const today = new Date().toISOString().slice(0, 10);
  const inSevenDays = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  const visible = leads.filter((l) => {
    if (filter === "all") return true;
    if (filter === "due") return !!l.follow_up_at && l.follow_up_at >= today && l.follow_up_at <= inSevenDays;
    return l.status === filter;
  });

  const counts = {
    new: leads.filter((l) => l.status === "new").length,
    contacted: leads.filter((l) => l.status === "contacted").length,
    follow_up: leads.filter((l) => l.status === "follow_up").length,
    replied: leads.filter((l) => l.status === "replied").length,
  };

  const filters: Filter[] = ["all", "new", "contacted", "follow_up", "replied", "due"];

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-neutral-900">{campaign.name}</h1>
        <p className="mt-1 text-sm text-neutral-600">
          {campaign.product_name} → {campaign.target_market}
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          {campaign.research_mode === "web" ? "Web research" : "Simulated research"} ·{" "}
          {counts.new} new · {counts.contacted} contacted · {counts.follow_up} follow-up ·{" "}
          {counts.replied} replied
        </p>
      </header>

      <div className="mb-6 flex flex-wrap gap-3">
        <button onClick={runResearch} disabled={busy !== null}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy === "research" ? "Researching…" : leads.length ? "Re-run research" : "Find leads"}
        </button>
        <button onClick={runDrafts} disabled={busy !== null || leads.length === 0}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy === "draft" ? "Drafting…" : "Draft messages"}
        </button>
      </div>

      {progress.length > 0 && (
        <ul className="mb-6 space-y-1 rounded-md bg-neutral-50 p-3 text-sm text-neutral-600">
          {progress.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      {error && <p className="mb-6 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {leads.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {filters.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-xs ${
                filter === f ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700"
              }`}>
              {f === "due" ? "Due this week" : f.replace("_", " ")}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-4">
        {visible.map((lead) => (
          <LeadCard key={lead.id} lead={lead} message={messageByLead.get(lead.id) ?? null}
            onLeadChange={onLeadChange} onMessageChange={onMessageChange} />
        ))}
        {leads.length === 0 && busy !== "research" && (
          <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
            No leads yet. Run research to find them.
          </p>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Write the lead card**

Create `app/campaigns/[id]/lead-card.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { LeadRow, MessageRow, LeadStatus } from "@/lib/types";
import { LEAD_STATUSES } from "@/lib/schemas";

export function LeadCard({
  lead,
  message,
  onLeadChange,
  onMessageChange,
}: {
  lead: LeadRow;
  message: MessageRow | null;
  onLeadChange: (l: LeadRow) => void;
  onMessageChange: (m: MessageRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(message?.subject ?? "");
  const [body, setBody] = useState(message?.body ?? "");
  const [saving, setSaving] = useState(false);

  async function patchLead(patch: Partial<Pick<LeadRow, "status" | "follow_up_at">>) {
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) onLeadChange((await res.json()).lead);
  }

  async function patchMessage(patch: Record<string, unknown>) {
    if (!message) return;
    setSaving(true);
    const res = await fetch(`/api/messages/${message.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) onMessageChange((await res.json()).message);
    setSaving(false);
  }

  return (
    <article className="rounded-lg border border-neutral-200 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-neutral-900">
            {lead.company_name}
            {!lead.sourced && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">
                Simulated
              </span>
            )}
          </h2>
          <p className="text-sm text-neutral-600">
            {lead.contact_role}
            {lead.location ? ` · ${lead.location}` : ""}
            {lead.fit_score !== null ? ` · fit ${lead.fit_score}` : ""}
          </p>
        </div>
        <select value={lead.status} onChange={(e) => patchLead({ status: e.target.value as LeadStatus })}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs">
          {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
      </div>

      <p className="mt-3 text-sm text-neutral-700">{lead.fit_reason}</p>

      {lead.sources.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {lead.sources.map((s, i) => (
            <li key={i}>
              <a href={s.url} target="_blank" rel="noopener noreferrer"
                className="text-xs text-blue-700 underline">{s.title}</a>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-center gap-2 text-xs text-neutral-600">
        <label htmlFor={`fu-${lead.id}`}>Follow up</label>
        <input id={`fu-${lead.id}`} type="date" value={lead.follow_up_at ?? ""}
          onChange={(e) => patchLead({ follow_up_at: e.target.value || null })}
          className="rounded-md border border-neutral-300 px-2 py-1" />
      </div>

      {message && (
        <div className="mt-4 rounded-md bg-neutral-50 p-4">
          {editing ? (
            <>
              <input value={subject} onChange={(e) => setSubject(e.target.value)}
                className="mb-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm" />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7}
                className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm" />
              <div className="mt-2 flex gap-2">
                <button disabled={saving}
                  onClick={async () => { await patchMessage({ subject, body }); setEditing(false); }}
                  className="rounded-md bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50">Save</button>
                <button onClick={() => setEditing(false)}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-xs">Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-neutral-900">{message.subject}</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-700">{message.body}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button onClick={() => { setSubject(message.subject ?? ""); setBody(message.body); setEditing(true); }}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-xs">Edit</button>
                <button disabled={saving || message.status === "approved"}
                  onClick={() => patchMessage({ status: "approved" })}
                  className="rounded-md bg-green-700 px-3 py-1 text-xs text-white disabled:opacity-50">
                  {message.status === "approved" ? "Approved" : "Approve"}
                </button>
                <button onClick={() => navigator.clipboard.writeText(`${message.subject}\n\n${message.body}`)}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-xs">Copy</button>
                {message.is_edited && <span className="text-xs text-neutral-500">edited</span>}
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}
```

`LeadStatus` must be re-exported from `lib/types.ts` for this import to work — add `export type { LeadStatus } from "./schemas";` to `lib/types.ts`.

- [ ] **Step 4: Verify end to end**

Run `npm run dev`. Create a simulated campaign, click **Find leads**, watch progress stream in, click **Draft messages**, edit one, approve it, set a follow-up date, switch to the **Due this week** filter.

Expected: every action persists across a page reload.

- [ ] **Step 5: Commit**

```bash
git add app/campaigns/\[id\] lib/types.ts
git commit -m "feat: campaign review dashboard with streaming research, drafts, status and follow-ups"
```

---

### Task 13: Home dashboard and deploy config

**Files:**
- Create: `app/page.tsx` (replace the scaffold default), `vercel.json`
- Modify: `app/layout.tsx`

**Interfaces:**
- Consumes: `GET /api/campaigns`
- Produces: the campaign list landing page

- [ ] **Step 1: Replace the home page**

Overwrite `app/page.tsx`:

```tsx
import Link from "next/link";
import { getDb } from "@/lib/db";
import type { CampaignRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = getDb();
  const { data } = await db
    .from("campaigns")
    .select("*, leads(count), messages(count)")
    .order("created_at", { ascending: false });

  const campaigns = (data ?? []) as (CampaignRow & { leads: { count: number }[]; messages: { count: number }[] })[];

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Campaigns</h1>
          <p className="mt-1 text-sm text-neutral-600">Catalog in, researched leads and drafted outreach out.</p>
        </div>
        <Link href="/campaigns/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white">New campaign</Link>
      </div>

      {campaigns.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
          No campaigns yet. Create one to get started.
        </p>
      ) : (
        <ul className="space-y-3">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Link href={`/campaigns/${c.id}`}
                className="block rounded-lg border border-neutral-200 p-5 hover:border-neutral-400">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-medium text-neutral-900">{c.name}</h2>
                    <p className="text-sm text-neutral-600">{c.product_name}</p>
                  </div>
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">{c.status}</span>
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  {c.leads?.[0]?.count ?? 0} leads · {c.messages?.[0]?.count ?? 0} drafts ·{" "}
                  {c.research_mode === "web" ? "web research" : "simulated"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Set the app title**

In `app/layout.tsx`, replace the scaffold metadata:

```typescript
export const metadata = {
  title: "LeadPilot",
  description: "Agentic sales outreach — research leads, draft messages, track follow-ups.",
};
```

- [ ] **Step 3: Run the full check**

Run: `npm test && npm run build`
Expected: all tests pass, build succeeds with no type errors.

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "feat: campaign dashboard home page and app metadata"
git push -u origin main
```

- [ ] **Step 5: Deploy**

Import the GitHub repo in Vercel. Set `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` as environment variables for Production and Preview. Enable Fluid compute so `maxDuration = 300` applies; without it research runs are capped at 60s, which is tight for web mode.

Verify on the deployed URL: create a simulated campaign, research, draft, approve.

---

## Self-Review Notes

**Spec coverage:** §2 stack → Task 1. §4 schema → Task 1 step 6. §5.1 research two stages → Tasks 6, 7. §5.2 draft agent → Task 9. §5.3 Zod schemas → Task 2. §6 API contracts → Tasks 5, 8, 10, 11. §7 error handling → Task 3, applied in 8/10/11. §8 testing → Tasks 2, 3, 6, 7, 9. §9 environment → Task 1 step 8. §10 build order → task order. §11 CLAUDE.md → Task 1 step 9. §12 assumptions → carried into Task 13 step 5 (Fluid compute).

**Known deviation from spec:** `personalization_note` is produced by `DraftSchema` but has no column and is not persisted (Task 10). The spec's §5.3 comment says it is "shown in review UI" — that is not implemented in v1 and would need a migration. Called out at the point of divergence rather than silently dropped.

**Type consistency:** `Usage` is defined once in `lib/agents/research.ts` and imported by `draft.ts`. `LeadRow` is defined in `lib/types.ts` and used by both agents and routes. `ResearchInput` names match `CampaignRow` field names exactly.
