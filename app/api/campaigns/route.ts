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
        {
          error: "Invalid campaign",
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        { status: 400 },
      );
    }

    const db = getDb();
    const { data, error } = await db.from("campaigns").insert(parsed.data).select().single();
    if (error) {
      return NextResponse.json(
        { error: "Could not create campaign", detail: error.message },
        { status: 500 },
      );
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
      return NextResponse.json(
        { error: "Could not list campaigns", detail: error.message },
        { status: 500 },
      );
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
