import { NextRequest, NextResponse } from "next/server";
import { pipelineSummary } from "@/lib/pipeline";
import { prisma } from "@/lib/prisma";

/** How far leads got, across every campaign, or one with ?campaignId=. */
export async function GET(req: NextRequest) {
  const campaignId = req.nextUrl.searchParams.get("campaignId") ?? undefined;
  return NextResponse.json(await pipelineSummary(prisma, campaignId));
}
