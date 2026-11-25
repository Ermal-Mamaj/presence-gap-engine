import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * A copy of the whole database as one file: every campaign, lead, draft,
 * template and note. SQLite's VACUUM INTO writes a consistent snapshot even
 * while the app is running (copying the file itself could catch it
 * mid-write). To restore, stop the app and put the file in place of dev.db.
 */
export async function createBackup(prisma: PrismaClient, now: Date = new Date()): Promise<{ data: Buffer; filename: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pge-backup-"));
  const file = path.join(dir, "backup.db");
  try {
    // The path is ours (a fresh temp directory), but a quote in it would still end the string.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return { data: await readFile(file), filename: `presence-gap-engine-backup-${now.toISOString().slice(0, 10)}.db` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
