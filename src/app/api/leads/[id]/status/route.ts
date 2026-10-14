import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidTransitionError, LeadNotFoundError, leadUpdateSchema, updateLead } from "@/lib/leads";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  const parsed = leadUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await updateLead(prisma, id, parsed.data));
  } catch (err) {
    if (err instanceof LeadNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof InvalidTransitionError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
