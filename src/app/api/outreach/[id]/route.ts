import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DraftAlreadySentError, draftEditSchema, DraftNotFoundError, editDraft } from "@/lib/review";

/** Saves edits to a draft's subject and text; refused once it has been sent. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  const parsed = draftEditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join(" ") }, { status: 400 });
  }
  try {
    return NextResponse.json(await editDraft(prisma, id, parsed.data));
  } catch (err) {
    if (err instanceof DraftNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof DraftAlreadySentError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
