import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const VALID_STAGES = ["NEW", "QUALIFIED", "CONTACTED", "REPLIED", "CONVERTED", "DELIVERED", "RETAINED", "DEAD"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { crmStage, notes } = body;

  if (crmStage && !VALID_STAGES.includes(crmStage)) {
    return NextResponse.json({ error: `crmStage must be one of ${VALID_STAGES.join(", ")}` }, { status: 400 });
  }

  const business = await prisma.business.update({
    where: { id },
    data: {
      ...(crmStage ? { crmStage } : {}),
      ...(notes !== undefined ? { notes } : {}),
    },
  });
  return NextResponse.json(business);
}
