import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_LANGUAGE, DRAFT_LANGUAGES, type DraftLanguage } from "@/lib/outreachOptions";
import { prisma } from "@/lib/prisma";
import { MAX_PLACES, splitRegions } from "@/lib/regions";

const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  region: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((region) => splitRegions(region).length <= MAX_PLACES, `a campaign can search at most ${MAX_PLACES} places, separated by semicolons`),
  niche: z.string().trim().min(1).max(100),
  source: z.enum(["OSM", "GOOGLE_MAPS_SCRAPER"]),
  language: z.enum(Object.keys(DRAFT_LANGUAGES) as [DraftLanguage, ...DraftLanguage[]]).default(DEFAULT_LANGUAGE),
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
    const about = (field: string) => parsed.error.issues.some((i) => i.path[0] === field);
    const tooMany = parsed.error.issues.find((i) => i.path[0] === "region" && i.code === "custom");
    const missing = tooMany
      ? tooMany.message
      : about("source")
      ? "source must be OSM or GOOGLE_MAPS_SCRAPER"
      : about("language")
      ? `language must be one of ${Object.keys(DRAFT_LANGUAGES).join(", ")}`
      : "name, region, and niche are required (name up to 120, region up to 300, niche up to 100 characters)";
    return NextResponse.json({ error: missing }, { status: 400 });
  }

  const campaign = await prisma.campaign.create({ data: parsed.data });
  return NextResponse.json(campaign, { status: 201 });
}
