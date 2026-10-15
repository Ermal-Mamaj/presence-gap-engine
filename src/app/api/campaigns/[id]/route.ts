import { NextRequest, NextResponse } from "next/server";
import { campaignUpdateSchema, deleteCampaign, updateCampaign } from "@/lib/campaigns";
import { prisma } from "@/lib/prisma";
import { CampaignNotFoundError, ScanConflictError } from "@/lib/scan";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      businesses: {
        orderBy: { score: "desc" },
        include: { signals: true },
      },
      scans: { orderBy: { startedAt: "desc" }, take: 5 },
    },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  return NextResponse.json(campaign);
}

/** Renames the campaign and/or changes its draft language. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  const parsed = campaignUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  try {
    return NextResponse.json(await updateCampaign(prisma, id, parsed.data));
  } catch (err) {
    if (err instanceof CampaignNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}

/** Deletes the campaign and everything in it. Refused (409) while a scan is running. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    await deleteCampaign(prisma, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof CampaignNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ScanConflictError) {
      return NextResponse.json({ error: "A scan is running. Wait for it to finish, then delete." }, { status: 409 });
    }
    throw err;
  }
}
