import { NextResponse } from "next/server";
import { UpdateLeadSchema } from "@/lib/schemas";
import { getDb } from "@/lib/db";
import { toErrorResponse } from "@/lib/errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH /api/leads/:id -> update pipeline status and/or follow-up date. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
    }

    const parsed = UpdateLeadSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid update",
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        { status: 400 },
      );
    }

    const db = getDb();
    // maybeSingle: single() reports "no rows" as an error, which would surface a
    // missing lead as a 500 instead of a 404.
    const { data, error } = await db
      .from("leads")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: "Could not update lead", detail: error.message },
        { status: 500 },
      );
    }
    if (!data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    return NextResponse.json({ lead: data });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
