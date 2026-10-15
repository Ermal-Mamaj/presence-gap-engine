import { after, NextRequest, NextResponse } from "next/server";
import { checkProgress, configuredProvider, DEFAULT_CHECK_LIMIT, MAX_CHECK_LIMIT, runOnlineCheck } from "@/lib/onlineCheck";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

// Each lead is a search plus up to five page fetches, one lead at a time.
export const maxDuration = 300;

/** How the online check is set up, and the latest run's progress for this campaign. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({ provider: configuredProvider()?.name ?? null, progress: checkProgress(id) });
}

/**
 * Starts the online check for the campaign's offline-looking leads and
 * answers at once; poll GET for progress. Body: { limit?: 1..50 }.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body: unknown = await req.json().catch(() => ({}));
  const limit = body && typeof body === "object" ? (body as { limit?: unknown }).limit : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= MAX_CHECK_LIMIT)) {
    return NextResponse.json({ error: `limit must be a whole number from 1 to ${MAX_CHECK_LIMIT}` }, { status: 400 });
  }
  if (!(await prisma.campaign.findUnique({ where: { id }, select: { id: true } }))) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (!configuredProvider()) {
    return NextResponse.json({ error: "No search provider is set up. Set GROQ_API_KEY or TAVILY_API_KEY in .env." }, { status: 503 });
  }
  if (checkProgress(id)?.running) {
    return NextResponse.json({ error: "The online check for this campaign is already running." }, { status: 409 });
  }
  after(async () => {
    try {
      await runOnlineCheck(prisma, id, (limit as number | undefined) ?? DEFAULT_CHECK_LIMIT);
    } catch (err) {
      console.error(`Online check for campaign ${id} failed`, err);
    }
  });
  return NextResponse.json({ status: "RUNNING" }, { status: 202 });
}
