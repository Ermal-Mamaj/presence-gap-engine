-- AlterTable
ALTER TABLE "Business" ADD COLUMN "followUpAt" DATETIME;

-- AlterTable
ALTER TABLE "Outreach" ADD COLUMN "sentAt" DATETIME;

-- CreateIndex
CREATE INDEX "Business_followUpAt_idx" ON "Business"("followUpAt");
