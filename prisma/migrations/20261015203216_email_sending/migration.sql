-- AlterTable
ALTER TABLE "Outreach" ADD COLUMN "emailMessageId" TEXT;
ALTER TABLE "Outreach" ADD COLUMN "sentVia" TEXT;

-- CreateTable
CREATE TABLE "DoNotContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "DoNotContact_value_key" ON "DoNotContact"("value");
