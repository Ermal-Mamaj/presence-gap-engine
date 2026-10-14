import { NextRequest, NextResponse } from "next/server";
import { fromStoredSignal } from "@/lib/detect";
import { prisma } from "@/lib/prisma";
import { draftOutreach, OutreachError } from "@/lib/outreach";
import { defaultChannel, DEFAULT_LANGUAGE, DRAFT_CHANNELS, isDraftChannel, isDraftLanguage } from "@/lib/outreachOptions";

const STATUS_BY_KIND = {
  no_verified_gaps: 422,
  not_configured: 503,
  invalid_response: 502,
  upstream: 502,
} as const;

/**
 * Drafts outreach for one lead. The body may name a channel ("email",
 * "phone", "message"); without one, the draft is for a channel the lead can
 * actually be reached on. The language is the campaign's.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // An empty body is fine: the channel is optional.
  const body: unknown = await req.json().catch(() => ({}));
  const requested = body && typeof body === "object" ? (body as { channel?: unknown }).channel : undefined;
  if (requested !== undefined && !isDraftChannel(requested)) {
    return NextResponse.json({ error: `channel must be one of ${DRAFT_CHANNELS.join(", ")}` }, { status: 400 });
  }

  const business = await prisma.business.findUnique({ where: { id }, include: { signals: true, campaign: true } });
  if (!business) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }
  const channel = requested ?? defaultChannel(business);
  const language = isDraftLanguage(business.campaign.language) ? business.campaign.language : DEFAULT_LANGUAGE;

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
      business.signals.map(fromStoredSignal),
      {},
      { channel, language }
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
      channel,
      subject: draft.subject,
      openLine: draft.openLine,
      body: draft.body,
    },
  });

  return NextResponse.json(outreach, { status: 201 });
}
