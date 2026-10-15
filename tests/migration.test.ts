import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const migrationsDir = path.resolve("prisma/migrations");
const migrations = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sql = (name: string) => fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pge-migration-"));
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("migrations", () => {
  it("are ordered init first, reliability second", () => {
    expect(migrations[0]).toMatch(/_init$/);
    expect(migrations[1]).toMatch(/_reliability_scans$/);
    expect(migrations[2]).toMatch(/_contact_channels$/);
    expect(migrations[3]).toMatch(/_website_check_limit$/);
    expect(migrations[4]).toMatch(/_draft_language$/);
  });

  it("date existing website checks from the last scan that saw the lead", () => {
    const db = new Database(path.join(tempDir, "legacy3.db"));
    try {
      for (const name of migrations.slice(0, 3)) db.exec(sql(name));
      db.exec(`
        INSERT INTO "Campaign" ("id","name","region","niche","updatedAt") VALUES ('c1','n','r','n',CURRENT_TIMESTAMP);
        INSERT INTO "Business" ("id","campaignId","name","dedupeKey","website","lastSeenAt","updatedAt")
          VALUES ('w','c1','With site','k1','klinika.al','2026-09-01 10:00:00',CURRENT_TIMESTAMP);
        INSERT INTO "Business" ("id","campaignId","name","dedupeKey","website","lastSeenAt","updatedAt")
          VALUES ('b','c1','Blank site','k2','  ','2026-09-01 10:00:00',CURRENT_TIMESTAMP);
        INSERT INTO "Business" ("id","campaignId","name","dedupeKey","lastSeenAt","updatedAt")
          VALUES ('n','c1','No site','k3','2026-09-01 10:00:00',CURRENT_TIMESTAMP);
        INSERT INTO "ScanRun" ("id","campaignId","found") VALUES ('r1','c1',3);
      `);

      db.exec(sql(migrations[3]));

      const checkedAt = Object.fromEntries(
        db.prepare(`SELECT "id","siteCheckedAt" FROM "Business"`).all().map((r) => {
          const row = r as { id: string; siteCheckedAt: string | null };
          return [row.id, row.siteCheckedAt];
        })
      );
      // Before this migration every returned website was checked, so the last
      // sighting is the last check. A lead without a website has none.
      expect(checkedAt).toEqual({ w: "2026-09-01 10:00:00", b: null, n: null });
      expect(db.prepare(`SELECT "found","deferred" FROM "ScanRun"`).get()).toEqual({ found: 3, deferred: 0 });
    } finally {
      db.close();
    }
  });

  it("upgrade a database that already holds leads without losing or merging any of them", () => {
    const db = new Database(path.join(tempDir, "legacy.db"));
    try {
      // The database as the previous version of the app left it.
      db.exec(sql(migrations[0]));
      db.exec(`
        INSERT INTO "Campaign" ("id","name","region","niche","updatedAt") VALUES ('c1','Dentists','Prizren','dentist', CURRENT_TIMESTAMP);
        INSERT INTO "Campaign" ("id","name","region","niche","updatedAt") VALUES ('c2','Hotels','Peja','hotel', CURRENT_TIMESTAMP);

        -- a and b share a source reference inside one campaign; a is older
        INSERT INTO "Business" ("id","campaignId","name","sourceRef","crmStage","notes","score","createdAt","updatedAt")
          VALUES ('a','c1','Clinic A','osm:node/1','CONTACTED','called Monday',44,'2026-01-01 10:00:00',CURRENT_TIMESTAMP);
        INSERT INTO "Business" ("id","campaignId","name","sourceRef","createdAt","updatedAt")
          VALUES ('b','c1','Clinic A again','osm:node/1','2026-01-02 10:00:00',CURRENT_TIMESTAMP);
        INSERT INTO "Business" ("id","campaignId","name","sourceRef","createdAt","updatedAt")
          VALUES ('c','c1','No ref',NULL,'2026-01-03 10:00:00',CURRENT_TIMESTAMP);
        INSERT INTO "Business" ("id","campaignId","name","sourceRef","createdAt","updatedAt")
          VALUES ('d','c1','Clinic D','osm:node/2','2026-01-04 10:00:00',CURRENT_TIMESTAMP);
        -- the same reference in another campaign is not a duplicate
        INSERT INTO "Business" ("id","campaignId","name","sourceRef","createdAt","updatedAt")
          VALUES ('e','c2','Clinic A elsewhere','osm:node/1','2026-01-05 10:00:00',CURRENT_TIMESTAMP);

        INSERT INTO "GapSignal" ("id","businessId","key","label","severity","detail") VALUES ('s1','a','no_website','No website found',40,NULL);
        INSERT INTO "Outreach" ("id","businessId","subject","body","openLine") VALUES ('o1','a','Hello','Body','Open');
      `);

      db.exec(sql(migrations[1]));

      const keys = Object.fromEntries(
        db.prepare(`SELECT "id","dedupeKey" FROM "Business"`).all().map((r) => {
          const row = r as { id: string; dedupeKey: string };
          return [row.id, row.dedupeKey];
        })
      );
      expect(keys).toEqual({
        a: "ref:osm:node/1",
        b: "id:b",
        c: "id:c",
        d: "ref:osm:node/2",
        e: "ref:osm:node/1",
      });

      // Existing work is intact, and new columns have honest defaults.
      const a = db.prepare(`SELECT * FROM "Business" WHERE "id" = 'a'`).get() as Record<string, unknown>;
      expect(a).toMatchObject({ crmStage: "CONTACTED", notes: "called Monday", score: 44, websiteStatus: "NEEDS_CHECK" });
      expect(a.lastSeenAt).toBeTruthy();
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "Business"`).get()).toEqual({ n: 5 });

      expect(db.prepare(`SELECT "certainty" FROM "GapSignal" WHERE "id" = 's1'`).get()).toEqual({ certainty: "VERIFIED" });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "Outreach" WHERE "businessId" = 'a'`).get()).toEqual({ n: 1 });
      expect(db.pragma("foreign_key_check")).toEqual([]);

      // The unique index is in place.
      expect(() =>
        db.exec(
          `INSERT INTO "Business" ("id","campaignId","name","dedupeKey","updatedAt") VALUES ('z','c1','Dup','ref:osm:node/1',CURRENT_TIMESTAMP)`
        )
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it("let a legacy campaign be scanned and its new tables used", () => {
    const db = new Database(path.join(tempDir, "legacy2.db"));
    try {
      db.exec(sql(migrations[0]));
      db.exec(`INSERT INTO "Campaign" ("id","name","region","niche","updatedAt") VALUES ('c1','n','r','n',CURRENT_TIMESTAMP)`);
      db.exec(sql(migrations[1]));
      db.exec(`INSERT INTO "ScanRun" ("id","campaignId") VALUES ('r1','c1')`);
      expect(db.prepare(`SELECT "status","found" FROM "ScanRun"`).get()).toEqual({ status: "RUNNING", found: 0 });
    } finally {
      db.close();
    }
  });
});
