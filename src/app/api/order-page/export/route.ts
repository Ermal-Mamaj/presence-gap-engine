import { NextResponse } from "next/server";
import { csvFilename, toCsv } from "@/lib/csv";
import { fetchTrialStats, orderPageCandidates } from "@/lib/orderPage";
import { prisma } from "@/lib/prisma";

const HEADERS = ["name", "instagram", "facebook", "phone", "email", "address", "campaign", "crm_stage", "why", "link", "opened", "tried_demo", "demo_orders", "signed_up"];

/** The shops an order page fits, with each one's link, for working through by hand. */
export async function GET() {
  const { stats } = await fetchTrialStats();
  const rows = (await orderPageCandidates(prisma, stats)).map((c) => [
    c.name,
    c.instagram,
    c.facebook,
    c.phone,
    c.email,
    c.address,
    c.campaign.name,
    c.crmStage,
    c.reasons.join("; "),
    c.link,
    c.visits?.view,
    c.visits?.demo,
    c.visits?.demo_order,
    c.visits?.signup,
  ]);
  return new NextResponse(toCsv(HEADERS, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("order-page", "shops")}"`,
      "Cache-Control": "no-store",
    },
  });
}
