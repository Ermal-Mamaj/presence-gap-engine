import { NextRequest, NextResponse } from "next/server";
import { markOutreachSent, OutreachNotFoundError } from "@/lib/leads";
import { prisma } from "@/lib/prisma";

/**
 * Records that a draft was sent; see markOutreachSent for what it does to the
 * lead. The body may carry the browser's own date ({ today: "2026-10-17" }),
 * so the follow-up is planned from the user's day rather than the server's.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await req.json().catch(() => ({}));
  const today = body && typeof body === "object" ? (body as { today?: unknown }).today : undefined;
  try {
    return NextResponse.json(await markOutreachSent(prisma, id, { today: typeof today === "string" ? today : undefined }));
  } catch (err) {
    if (err instanceof OutreachNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
