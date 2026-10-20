import { NextRequest, NextResponse } from "next/server";
import { MailError, type MailErrorKind, sendDraftEmail } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

const STATUS: Record<MailErrorKind, number> = {
  not_found: 404,
  already_sent: 409,
  in_progress: 409,
  not_email: 422,
  no_address: 422,
  do_not_contact: 422,
  not_configured: 503,
  daily_limit: 429,
  outdated: 409,
  send_failed: 502,
  sent_not_recorded: 500,
};

/**
 * Sends an email draft from the configured mailbox and records it as sent.
 * The body may carry the browser's own date ({ today }) for the follow-up.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await req.json().catch(() => ({}));
  const today = body && typeof body === "object" ? (body as { today?: unknown }).today : undefined;
  try {
    return NextResponse.json(await sendDraftEmail(prisma, id, { today: typeof today === "string" ? today : undefined }));
  } catch (err) {
    if (err instanceof MailError) return NextResponse.json({ error: err.message, kind: err.kind }, { status: STATUS[err.kind] });
    throw err;
  }
}
