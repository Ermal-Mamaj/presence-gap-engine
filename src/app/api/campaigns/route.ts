import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { businesses: true } } },
  });
  return NextResponse.json(campaigns);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, region, niche, source } = body;

  if (!name || !region || !niche) {
    return NextResponse.json({ error: "name, region, and niche are required" }, { status: 400 });
  }
  if (source !== "OSM" && source !== "GOOGLE_MAPS_SCRAPER") {
    return NextResponse.json({ error: "source must be OSM or GOOGLE_MAPS_SCRAPER" }, { status: 400 });
  }

  const campaign = await prisma.campaign.create({
    data: { name, region, niche, source },
  });
  return NextResponse.json(campaign, { status: 201 });
}
