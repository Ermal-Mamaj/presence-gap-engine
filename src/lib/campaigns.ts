import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { DRAFT_LANGUAGES, type DraftLanguage } from "./outreachOptions";
import { CampaignNotFoundError, DEFAULT_STALE_AFTER_MS, ScanConflictError } from "./scan";

export const campaignUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    language: z.enum(Object.keys(DRAFT_LANGUAGES) as [DraftLanguage, ...DraftLanguage[]]).optional(),
  })
  .refine((v) => v.name !== undefined || v.language !== undefined, { message: "Provide name and/or language" });

export type CampaignUpdate = z.infer<typeof campaignUpdateSchema>;

/** Renames a campaign or changes the language its drafts are written in. Leads are untouched. */
export async function updateCampaign(prisma: PrismaClient, id: string, update: CampaignUpdate) {
  // updatedAt is the scan claim's heartbeat (see claimCampaignScan). A rename
  // is not scan progress, so it keeps the old value: otherwise editing a
  // campaign whose scan crashed would postpone its recovery by 15 minutes.
  // The write only lands if updatedAt is still what was read, so a heartbeat
  // arriving in between is never rewound; then it reads again and retries.
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await prisma.campaign.findUnique({ where: { id }, select: { updatedAt: true } });
    if (!current) throw new CampaignNotFoundError();
    const written = await prisma.campaign.updateMany({
      where: { id, updatedAt: current.updatedAt },
      data: { ...update, updatedAt: current.updatedAt },
    });
    if (written.count === 1) return prisma.campaign.findUniqueOrThrow({ where: { id } });
  }
  throw new Error("The campaign kept changing while it was being saved; try again.");
}

/**
 * Deletes a campaign with everything in it: leads, signals, drafts, history
 * and scans (every relation cascades). Refused while a scan holds the
 * campaign, in the same statement that deletes it, so a scan starting at that
 * moment can't end up writing leads into a campaign that no longer exists.
 * A scan that went silent past the stale window is treated as crashed, as the
 * scan claim does, so a crash can't make a campaign undeletable.
 */
export async function deleteCampaign(
  prisma: PrismaClient,
  id: string,
  deps: { now?: () => Date; staleAfterMs?: number } = {}
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const staleCutoff = new Date(now().getTime() - (deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));
  const result = await prisma.campaign.deleteMany({
    where: { id, OR: [{ status: { not: "RUNNING" } }, { updatedAt: { lt: staleCutoff } }] },
  });
  if (result.count > 0) return;
  const exists = await prisma.campaign.findUnique({ where: { id }, select: { id: true } });
  throw exists ? new ScanConflictError() : new CampaignNotFoundError();
}
