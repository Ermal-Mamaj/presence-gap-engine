import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      businesses: {
        orderBy: { score: "desc" },
        include: { signals: true },
      },
      scans: { orderBy: { startedAt: "desc" }, take: 5 },
    },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  return NextResponse.json(campaign);
}
