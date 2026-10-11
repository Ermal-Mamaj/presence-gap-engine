import { NextRequest, NextResponse } from "next/server";
import { csvFilename, toCsv, type CsvValue } from "@/lib/csv";
import { prisma } from "@/lib/prisma";

// Verified and unverified gaps go in separate columns rather than one marked
// list, so the certainty split survives into the spreadsheet and can be
// filtered there. Collapsing them would let an unproven signal read as fact.
const HEADERS = [
  "name",
  "address",
  "phone",
  "website",
  "website_status",
  "score",
  "crm_stage",
  "rating",
  "review_count",
  "verified_gaps",
  "unverified_gaps",
  "latitude",
  "longitude",
  "last_seen_at",
  "notes",
];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      businesses: { orderBy: { score: "desc" }, include: { signals: true } },
    },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const rows: CsvValue[][] = campaign.businesses.map((b) => {
    const gaps = (certainty: string) =>
      b.signals
        .filter((s) => (certainty === "UNCERTAIN" ? s.certainty === "UNCERTAIN" : s.certainty !== "UNCERTAIN"))
        .map((s) => s.label)
        .join("; ");

    return [
      b.name,
      b.address,
      b.phone,
      b.website,
      b.websiteStatus,
      b.score,
      b.crmStage,
      b.rating,
      b.reviewCount,
      gaps("VERIFIED"),
      gaps("UNCERTAIN"),
      b.latitude,
      b.longitude,
      b.lastSeenAt,
      b.notes,
    ];
  });

  return new NextResponse(toCsv(HEADERS, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(campaign.name)}"`,
      // The export reflects the database at request time; never serve a stale copy.
      "Cache-Control": "no-store",
    },
  });
}
