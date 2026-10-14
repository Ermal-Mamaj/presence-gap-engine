import { NextRequest, NextResponse } from "next/server";
import { fromStoredSignal } from "@/lib/detect";
import { prisma } from "@/lib/prisma";
import { draftOutreach, OutreachError } from "@/lib/outreach";

const STATUS_BY_KIND = {
  no_verified_gaps: 422,
  not_configured: 503,
  invalid_response: 502,
  upstream: 502,
} as const;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const business = await prisma.business.findUnique({ where: { id }, include: { signals: true } });
  if (!business) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }

  let draft;
  try {
    draft = await draftOutreach(
      {
        name: business.name,
        address: business.address,
        website: business.website,
        rating: business.rating,
        reviewCount: business.reviewCount,
      },
      business.signals.map(fromStoredSignal)
    );
  } catch (err) {
    if (err instanceof OutreachError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_KIND[err.kind] });
    }
    return NextResponse.json({ error: "Failed to draft outreach" }, { status: 500 });
  }

  const outreach = await prisma.outreach.create({
    data: {
      businessId: business.id,
      subject: draft.subject,
      openLine: draft.openLine,
      body: draft.body,
    },
  });

  return NextResponse.json(outreach, { status: 201 });
}
