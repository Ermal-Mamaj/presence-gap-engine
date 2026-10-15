import { NextRequest, NextResponse } from "next/server";
import { markOutreachSent, OutreachNotFoundError } from "@/lib/leads";
import { prisma } from "@/lib/prisma";

/** Records that a draft was sent; see markOutreachSent for what it does to the lead. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await markOutreachSent(prisma, id));
  } catch (err) {
    if (err instanceof OutreachNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
