import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CampaignNotFoundError, DiscoveryError, runCampaignScan, ScanConflictError } from "@/lib/scan";
import { getSource } from "@/lib/sources";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    await runCampaignScan(prisma, id, { getSource });
  } catch (err) {
    if (err instanceof CampaignNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ScanConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // Leads saved by earlier scans are untouched; the campaign page still shows them.
    const status = err instanceof DiscoveryError ? 502 : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status });
  }

  const result = await prisma.campaign.findUnique({
    where: { id },
    include: {
      businesses: { orderBy: { score: "desc" }, include: { signals: true } },
      scans: { orderBy: { startedAt: "desc" }, take: 5 },
    },
  });
  return NextResponse.json(result);
}
