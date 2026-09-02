import { getDb } from "./db";

/**
 * Open an `agent_runs` row for an agent invocation.
 *
 * Bookkeeping must never take down the run it is recording, so a failed insert
 * yields `null` rather than throwing. `finishRun` no-ops on a null id.
 */
export async function startRun(
  campaignId: string,
  kind: "research" | "draft",
): Promise<string | null> {
  try {
    const db = getDb();
    const { data } = await db
      .from("agent_runs")
      .insert({ campaign_id: campaignId, kind, status: "running" })
      .select("id")
      .single();
    return (data?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Close an `agent_runs` row. Silently no-ops when `startRun` could not open one. */
export async function finishRun(
  runId: string | null,
  status: "succeeded" | "failed",
  opts: { error?: string; input_tokens?: number; output_tokens?: number } = {},
): Promise<void> {
  if (!runId) return;
  try {
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
  } catch {
    // The caller has already reported the real outcome to the client.
  }
}
