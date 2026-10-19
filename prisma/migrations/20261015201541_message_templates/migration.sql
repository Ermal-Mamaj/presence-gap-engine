-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "language" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "gapKey" TEXT NOT NULL,
    "niche" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Outreach" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "openLine" TEXT NOT NULL,
    "sentAt" DATETIME,
    "templateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Outreach_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Outreach_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Outreach" ("body", "businessId", "channel", "createdAt", "id", "openLine", "sentAt", "subject") SELECT "body", "businessId", "channel", "createdAt", "id", "openLine", "sentAt", "subject" FROM "Outreach";
DROP TABLE "Outreach";
ALTER TABLE "new_Outreach" RENAME TO "Outreach";
CREATE INDEX "Outreach_businessId_idx" ON "Outreach"("businessId");
CREATE INDEX "Outreach_templateId_idx" ON "Outreach"("templateId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MessageTemplate_language_channel_gapKey_idx" ON "MessageTemplate"("language", "channel", "gapKey");
