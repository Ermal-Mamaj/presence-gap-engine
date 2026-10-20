import { NextResponse } from "next/server";
import { createBackup } from "@/lib/backup";
import { prisma } from "@/lib/prisma";

// A fresh snapshot on every request, never a cached one.
export const dynamic = "force-dynamic";

/** Downloads a copy of the whole database as one .db file. */
export async function GET() {
  const { data, filename } = await createBackup(prisma);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/x-sqlite3",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(data.length),
      "Cache-Control": "no-store",
    },
  });
}
