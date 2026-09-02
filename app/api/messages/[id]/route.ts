import { NextResponse } from "next/server";
import { UpdateMessageSchema } from "@/lib/schemas";
import { getDb } from "@/lib/db";
import { toErrorResponse } from "@/lib/errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH /api/messages/:id -> edit the draft text and/or move it along the review flow. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid message id" }, { status: 400 });
    }

    const parsed = UpdateMessageSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid update",
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        { status: 400 },
      );
    }

    const update: Record<string, unknown> = {
      ...parsed.data,
      updated_at: new Date().toISOString(),
    };
    // Editing the text marks the message as human-edited; a pure status change does not.
    if (parsed.data.subject !== undefined || parsed.data.body !== undefined) {
      update.is_edited = true;
    }

    const db = getDb();
    // maybeSingle: single() reports "no rows" as an error, which would surface a
    // missing message as a 500 instead of a 404.
    const { data, error } = await db
      .from("messages")
      .update(update)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: "Could not update message", detail: error.message },
        { status: 500 },
      );
    }
    if (!data) return NextResponse.json({ error: "Message not found" }, { status: 404 });
    return NextResponse.json({ message: data });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
