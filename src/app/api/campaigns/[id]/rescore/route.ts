import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rescoreCampaign } from "@/lib/rescore";
import { CampaignNotFoundError } from "@/lib/scan";

/**
 * Recomputes every lead's score from its stored signals. No website is
 * fetched, so this is quick, unlike a rescan.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await rescoreCampaign(prisma, id));
  } catch (err) {
    if (err instanceof CampaignNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
