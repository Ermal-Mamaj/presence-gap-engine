import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { draftOutreach } from "@/lib/outreach";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const business = await prisma.business.findUnique({ where: { id }, include: { signals: true } });
  if (!business) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }

  const draft = await draftOutreach(
    {
      name: business.name,
      address: business.address,
      website: business.website,
      rating: business.rating,
      reviewCount: business.reviewCount,
    },
    business.signals.map((s) => ({ key: s.key, label: s.label, severity: s.severity, detail: s.detail ?? undefined }))
  );

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
