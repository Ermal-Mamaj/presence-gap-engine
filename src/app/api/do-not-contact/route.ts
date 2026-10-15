import { NextRequest, NextResponse } from "next/server";
import { addDoNotContact, listDoNotContact, MailError } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

export async function GET() {
  return NextResponse.json(await listDoNotContact(prisma));
}

/** Body: { value: an email address or a domain, reason? }. */
export async function POST(req: NextRequest) {
  const body: unknown = await req.json().catch(() => null);
  const { value, reason } = (body ?? {}) as { value?: unknown; reason?: unknown };
  if (typeof value !== "string") return NextResponse.json({ error: "value must be an email address or a domain" }, { status: 400 });
  try {
    return NextResponse.json(await addDoNotContact(prisma, value, typeof reason === "string" ? reason : null), { status: 201 });
  } catch (err) {
    if (err instanceof MailError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
