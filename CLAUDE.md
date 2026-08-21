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
