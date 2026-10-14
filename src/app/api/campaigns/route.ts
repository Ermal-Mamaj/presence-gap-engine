import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(200),
  niche: z.string().trim().min(1).max(100),
  source: z.enum(["OSM", "GOOGLE_MAPS_SCRAPER"]),
});

export async function GET() {
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { businesses: true } } },
  });
  return NextResponse.json(campaigns);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = createCampaignSchema.safeParse(body);
  if (!parsed.success) {
    const missing = parsed.error.issues.some((i) => i.path[0] === "source")
      ? "source must be OSM or GOOGLE_MAPS_SCRAPER"
      : "name, region, and niche are required (name up to 120, region up to 200, niche up to 100 characters)";
    return NextResponse.json({ error: missing }, { status: 400 });
  }

  const campaign = await prisma.campaign.create({ data: parsed.data });
  return NextResponse.json(campaign, { status: 201 });
}
