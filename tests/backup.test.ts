import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { createBackup } from "@/lib/backup";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

describe("createBackup", () => {
  it("is a database file holding everything, which opens on its own", async () => {
    const campaign = await prisma.campaign.create({ data: { name: "Suharekë", region: "Suharekë, Kosovo", niche: "anything" } });
    const lead = await prisma.business.create({ data: { campaignId: campaign.id, name: "Furra Pashtriku", dedupeKey: "k1", phone: "+383 48 100 026", notes: "Called, call back Monday" } });
    await prisma.outreach.create({ data: { businessId: lead.id, subject: "s", openLine: "o", body: "Përshëndetje" } });

    const { data, filename } = await createBackup(prisma, new Date("2026-10-20T12:00:00Z"));
    expect(filename).toBe("presence-gap-engine-backup-2026-10-20.db");
    expect(data.subarray(0, 15).toString()).toBe("SQLite format 3");

    // Open the bytes as a database of their own, apart from the live one.
    const dir = await mkdtemp(path.join(tmpdir(), "pge-restore-"));
    try {
      await writeFile(path.join(dir, "restored.db"), data);
      const restored = new Database(path.join(dir, "restored.db"), { readonly: true });
      expect(restored.prepare("select name from Campaign").all()).toEqual([{ name: "Suharekë" }]);
      expect(restored.prepare("select name, phone, notes from Business").all()).toEqual([
        { name: "Furra Pashtriku", phone: "+383 48 100 026", notes: "Called, call back Monday" },
      ]);
      expect(restored.prepare("select body from Outreach").all()).toEqual([{ body: "Përshëndetje" }]);
      restored.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves nothing behind in the temp folder", async () => {
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith("pge-backup-"));
    await createBackup(prisma);
    expect((await readdir(tmpdir())).filter((n) => n.startsWith("pge-backup-"))).toEqual(before);
  });
});
