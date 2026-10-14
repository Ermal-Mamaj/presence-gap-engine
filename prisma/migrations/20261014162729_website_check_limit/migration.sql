-- AlterTable
ALTER TABLE "Business" ADD COLUMN "siteCheckedAt" DATETIME;
ALTER TABLE "ScanRun" ADD COLUMN "deferred" INTEGER NOT NULL DEFAULT 0;

-- Until now every website a scan returned was also checked, so for existing
-- leads the last check is the last scan that saw them. Without this, every
-- existing lead would read as never checked and jump the queue.
UPDATE "Business" SET "siteCheckedAt" = "lastSeenAt" WHERE "website" IS NOT NULL AND TRIM("website") <> '';
