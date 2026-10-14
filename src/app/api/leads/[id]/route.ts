import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const business = await prisma.business.findUnique({
    where: { id },
    include: {
      signals: true,
      outreach: { orderBy: { createdAt: "desc" } },
      stageChanges: { orderBy: { createdAt: "desc" } },
      campaign: true,
    },
  });
  if (!business) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }
  return NextResponse.json(business);
}
