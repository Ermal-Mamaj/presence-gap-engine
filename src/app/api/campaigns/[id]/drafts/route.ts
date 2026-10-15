import { NextRequest, NextResponse } from "next/server";
import { draftTopLeads, MAX_BULK_DRAFTS } from "@/lib/drafting";
import { prisma } from "@/lib/prisma";

/**
 * Drafts the campaign's best leads that are ready for a first message; see
 * draftTopLeads for which. Body: { limit?: 1..20 }. The response comes when
 * every draft is done, about a minute for twenty.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await req.json().catch(() => ({}));
  const limit = body && typeof body === "object" ? (body as { limit?: unknown }).limit : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= MAX_BULK_DRAFTS)) {
    return NextResponse.json({ error: `limit must be a whole number from 1 to ${MAX_BULK_DRAFTS}` }, { status: 400 });
  }

  const campaign = await prisma.campaign.findUnique({ where: { id }, select: { id: true } });
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  const outcome = await draftTopLeads(prisma, id, { limit: limit as number | undefined });
  // Nothing drafted because no call could authenticate: say so as an error.
  if (outcome.stoppedBecause && outcome.drafted === 0) {
    return NextResponse.json({ ...outcome, error: outcome.stoppedBecause }, { status: 503 });
  }
  return NextResponse.json(outcome);
}
