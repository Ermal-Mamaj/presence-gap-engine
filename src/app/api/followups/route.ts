import { NextRequest, NextResponse } from "next/server";
import { dueFollowUps, parseFollowUpDay } from "@/lib/leads";
import { prisma } from "@/lib/prisma";

/**
 * Leads whose follow-up falls on or before `through`, a calendar day such as
 * 2026-10-17. The browser sends its own today, because "due today" depends
 * on the user's timezone and the server's may differ.
 */
export async function GET(req: NextRequest) {
  const through = parseFollowUpDay(req.nextUrl.searchParams.get("through") ?? "");
  if (!through) {
    return NextResponse.json({ error: "through must be a date like 2026-10-17" }, { status: 400 });
  }
  return NextResponse.json(await dueFollowUps(prisma, through));
}
