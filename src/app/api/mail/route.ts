import { NextResponse } from "next/server";
import { mailStatus } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

/** Whether the app can send email right now, and what is missing if not. Never returns the SMTP URL. */
export async function GET() {
  return NextResponse.json(await mailStatus(prisma));
}
