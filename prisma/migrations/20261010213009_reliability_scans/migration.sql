/*
  Hand-edited after generation: "Business"."dedupeKey" is NOT NULL, so existing
  rows are backfilled instead of failing the table copy.

  Backfill rule: the oldest lead per (campaign, sourceRef) gets "ref:<sourceRef>",
  which is what src/lib/dedupe.ts produces for OSM, so a re-scan matches the
  existing lead. Any other row (no sourceRef, or a duplicate sourceRef) gets a
  unique "id:<id>" key so the new unique index can always be created. Legacy
  Google Maps rows will not match a future scan; they stay as separate leads
  rather than being merged or deleted.
*/
-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "errorMessage" TEXT,
    "found" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "ScanRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StageChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "fromStage" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StageChange_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Business" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "rating" REAL,
    "reviewCount" INTEGER,
    "sourceRef" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "websiteStatus" TEXT NOT NULL DEFAULT 'NEEDS_CHECK',
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" REAL NOT NULL DEFAULT 0,
    "crmStage" TEXT NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Business_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Business" ("address", "campaignId", "createdAt", "crmStage", "dedupeKey", "id", "latitude", "longitude", "name", "notes", "phone", "rating", "reviewCount", "score", "sourceRef", "updatedAt", "website") SELECT "address", "campaignId", "createdAt", "crmStage",
    CASE
        WHEN "sourceRef" IS NOT NULL AND "id" = (
            SELECT "b2"."id" FROM "Business" AS "b2"
            WHERE "b2"."campaignId" = "Business"."campaignId" AND "b2"."sourceRef" = "Business"."sourceRef"
            ORDER BY "b2"."createdAt", "b2"."id" LIMIT 1
        ) THEN 'ref:' || "sourceRef"
        ELSE 'id:' || "id"
    END,
    "id", "latitude", "longitude", "name", "notes", "phone", "rating", "reviewCount", "score", "sourceRef", "updatedAt", "website" FROM "Business";
DROP TABLE "Business";
ALTER TABLE "new_Business" RENAME TO "Business";
CREATE INDEX "Business_campaignId_idx" ON "Business"("campaignId");
CREATE INDEX "Business_campaignId_score_idx" ON "Business"("campaignId", "score");
CREATE UNIQUE INDEX "Business_campaignId_dedupeKey_key" ON "Business"("campaignId", "dedupeKey");
CREATE TABLE "new_GapSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "detail" TEXT,
    "certainty" TEXT NOT NULL DEFAULT 'VERIFIED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GapSignal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_GapSignal" ("businessId", "createdAt", "detail", "id", "key", "label", "severity") SELECT "businessId", "createdAt", "detail", "id", "key", "label", "severity" FROM "GapSignal";
DROP TABLE "GapSignal";
ALTER TABLE "new_GapSignal" RENAME TO "GapSignal";
CREATE INDEX "GapSignal_businessId_idx" ON "GapSignal"("businessId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ScanRun_campaignId_startedAt_idx" ON "ScanRun"("campaignId", "startedAt");

-- CreateIndex
CREATE INDEX "StageChange_businessId_createdAt_idx" ON "StageChange"("businessId", "createdAt");
