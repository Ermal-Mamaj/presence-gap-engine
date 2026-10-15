import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createTemplate, listTemplates, templateInputSchema } from "@/lib/templates";

export async function GET() {
  return NextResponse.json(await listTemplates(prisma));
}

export async function POST(req: NextRequest) {
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
  return NextResponse.json(await createTemplate(prisma, parsed.data), { status: 201 });
}
