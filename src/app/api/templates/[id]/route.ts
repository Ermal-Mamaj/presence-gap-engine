import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deleteTemplate, templateInputSchema, TemplateNotFoundError, updateTemplate } from "@/lib/templates";

type Params = { params: Promise<{ id: string }> };

/** Replaces the template with the one sent: the editor always sends every field. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  const parsed = templateInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join(" ") }, { status: 400 });
  }
  try {
    return NextResponse.json(await updateTemplate(prisma, id, parsed.data));
  } catch (err) {
    if (err instanceof TemplateNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}

/** Drafts made from it keep their text. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    await deleteTemplate(prisma, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof TemplateNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
