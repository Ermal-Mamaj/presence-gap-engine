import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { canTransition, CRM_STAGES } from "./crm";

export class LeadNotFoundError extends Error {
  constructor() {
    super("Business not found");
    this.name = "LeadNotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`A lead in ${from} can't move to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export const leadUpdateSchema = z
  .object({
    crmStage: z.enum(CRM_STAGES).optional(),
    notes: z.string().max(10_000).nullable().optional(),
  })
  .refine((v) => v.crmStage !== undefined || v.notes !== undefined, {
    message: "Provide crmStage and/or notes",
  });

export type LeadUpdate = z.infer<typeof leadUpdateSchema>;

/**
 * Applies a stage and/or notes change. A stage change and its history row are
 * written together, so the log can't disagree with the lead.
 */
export async function updateLead(prisma: PrismaClient, id: string, update: LeadUpdate) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.business.findUnique({ where: { id } });
    if (!current) throw new LeadNotFoundError();

    const stageChanging = update.crmStage !== undefined && update.crmStage !== current.crmStage;
    if (stageChanging && !canTransition(current.crmStage, update.crmStage!)) {
      throw new InvalidTransitionError(current.crmStage, update.crmStage!);
    }

    const business = await tx.business.update({
      where: { id },
      data: {
        ...(stageChanging ? { crmStage: update.crmStage } : {}),
        ...(update.notes !== undefined ? { notes: update.notes } : {}),
      },
    });
    if (stageChanging) {
      await tx.stageChange.create({
        data: { businessId: id, fromStage: current.crmStage, toStage: update.crmStage! },
      });
    }
    return business;
  });
}
