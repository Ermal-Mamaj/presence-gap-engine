import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { outreachStats } from "@/lib/stats";

/** What works: replies by template, channel and business type, across every campaign or one with ?campaignId=. */
export async function GET(req: NextRequest) {
  const campaignId = req.nextUrl.searchParams.get("campaignId") ?? undefined;
  return NextResponse.json(await outreachStats(prisma, campaignId));
}
