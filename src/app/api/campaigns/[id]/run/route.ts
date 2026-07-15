import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSource } from "@/lib/sources";
import { detectGaps } from "@/lib/detect";
import { computeScore } from "@/lib/score";

const CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  await prisma.campaign.update({ where: { id }, data: { status: "RUNNING", errorMessage: null } });
  await prisma.business.deleteMany({ where: { campaignId: id } });

  try {
    const source = getSource(campaign.source);
    const rawBusinesses = await source.search({ region: campaign.region, niche: campaign.niche });

    await mapWithConcurrency(rawBusinesses, CONCURRENCY, async (raw) => {
      const signals = await detectGaps({ website: raw.website, rating: raw.rating, reviewCount: raw.reviewCount });
      const score = computeScore(signals, { rating: raw.rating, reviewCount: raw.reviewCount, phone: raw.phone });

      const business = await prisma.business.create({
        data: {
          campaignId: id,
          name: raw.name,
          address: raw.address,
          phone: raw.phone,
          website: raw.website,
          latitude: raw.latitude,
          longitude: raw.longitude,
          rating: raw.rating,
          reviewCount: raw.reviewCount,
          sourceRef: raw.sourceRef,
          score,
        },
      });

      if (signals.length) {
        await prisma.gapSignal.createMany({
          data: signals.map((s) => ({
            businessId: business.id,
            key: s.key,
            label: s.label,
            severity: s.severity,
            detail: s.detail,
          })),
        });
      }
    });

    await prisma.campaign.update({ where: { id }, data: { status: "DONE" } });
  } catch (err) {
    await prisma.campaign.update({
      where: { id },
      data: { status: "FAILED", errorMessage: err instanceof Error ? err.message : "Unknown error" },
    });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }

  const result = await prisma.campaign.findUnique({
    where: { id },
    include: { businesses: { orderBy: { score: "desc" }, include: { signals: true } } },
  });
  return NextResponse.json(result);
}
