import { NextRequest, NextResponse } from "next/server";
import { MailError, removeDoNotContact } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await removeDoNotContact(prisma, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof MailError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
