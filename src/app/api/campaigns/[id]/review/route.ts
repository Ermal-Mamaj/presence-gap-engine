import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { reviewQueue } from "@/lib/review";

/** The campaign's review queue: leads ready to send, needing a draft, and sent. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({ where: { id }, select: { id: true, name: true, language: true } });
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  return NextResponse.json({ campaign, ...(await reviewQueue(prisma, id)) });
}
