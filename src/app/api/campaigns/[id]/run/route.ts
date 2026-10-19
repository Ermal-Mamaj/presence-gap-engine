import { after, NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CampaignNotFoundError,
  claimCampaignScan,
  executeCampaignScan,
  ScanConflictError,
} from "@/lib/scan";
import { getSource } from "@/lib/sources";
import { configuredProvider, DEFAULT_CHECK_LIMIT, runOnlineCheck } from "@/lib/onlineCheck";

/**
 * Give the scan room where the platform honours it. A campaign can return 60
 * leads, each costing up to two URL candidates at an 8s deadline with one
 * retry, five at a time — minutes, not seconds.
 */
export const maxDuration = 300;

/**
 * Starts a scan and answers immediately; the client polls the campaign for the
 * result. The scan used to run inside this request, so a long one outlived it:
 * the work completed and ScanRun recorded it, but the browser lost the answer
 * with no way to recover it.
 *
 * The claim stays synchronous because it decides the status code — 404 for a
 * missing campaign, 409 when another scan holds it. Only the scan body is
 * deferred, via `after`, which runs it once the response has been sent.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // { "checkOnline": true } also runs the online check once the scan has succeeded.
  const body: unknown = await req.json().catch(() => ({}));
  const checkOnline = Boolean(body && typeof body === "object" && (body as { checkOnline?: unknown }).checkOnline === true);
  if (checkOnline && !configuredProvider()) {
    return NextResponse.json(
      { error: "No search provider is set up. Set GROQ_API_KEY, OPENROUTER_API_KEY or TAVILY_API_KEY in .env." },
      { status: 503 }
    );
  }

  let claim;
  try {
    claim = await claimCampaignScan(prisma, id);
  } catch (err) {
    if (err instanceof CampaignNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ScanConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  after(async () => {
    try {
      await executeCampaignScan(prisma, claim, { getSource });
    } catch (err) {
      // executeCampaignScan already recorded this on the ScanRun and the
      // campaign; nothing is listening for the rejection, so log and stop.
      console.error(`Scan ${claim.scanId} failed`, err);
      return; // no new leads to check
    }
    if (!checkOnline) return;
    try {
      await runOnlineCheck(prisma, id, DEFAULT_CHECK_LIMIT);
    } catch (err) {
      console.error(`Online check after the scan of campaign ${id} failed`, err);
    }
  });

  // 202: accepted and started, not finished. The campaign is RUNNING and the
  // client watches GET /api/campaigns/[id] until it isn't.
  return NextResponse.json({ scanId: claim.scanId, status: "RUNNING" }, { status: 202 });
}
