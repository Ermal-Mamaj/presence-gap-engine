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

export class OutreachNotFoundError extends Error {
  constructor() {
    super("Draft not found");
    this.name = "OutreachNotFoundError";
  }
}

/**
 * A follow-up is a calendar day, not a moment: "2026-10-17", as a date input
 * gives it. It is stored as UTC midnight of that day and must be read back
 * the same way (see followUpDay), so no timezone can shift it by one.
 */
export function parseFollowUpDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : date;
}

/** The calendar day a stored follow-up stands for. */
export function followUpDay(date: Date | string): string {
  return new Date(date).toISOString().slice(0, 10);
}

/** How long after sending a first message to plan the follow-up, when none is set. */
export const FOLLOW_UP_AFTER_DAYS = 3;

export const leadUpdateSchema = z
  .object({
    crmStage: z.enum(CRM_STAGES).optional(),
    notes: z.string().max(10_000).nullable().optional(),
    followUpAt: z
      .string()
      .nullable()
      .transform((v, ctx) => {
        if (v === null) return null;
        const date = parseFollowUpDay(v);
        if (!date) {
          ctx.addIssue({ code: "custom", message: "followUpAt must be a date like 2026-10-17, or null" });
          return z.NEVER;
        }
        return date;
      })
      .optional(),
  })
  .refine((v) => v.crmStage !== undefined || v.notes !== undefined || v.followUpAt !== undefined, {
    message: "Provide crmStage, notes and/or followUpAt",
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
        ...(update.followUpAt !== undefined ? { followUpAt: update.followUpAt } : {}),
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

/**
 * Records that a draft was sent, and moves the lead along with it: a lead not
 * yet contacted becomes CONTACTED (with its history row), and gets a follow-up
 * FOLLOW_UP_AFTER_DAYS later unless one is already planned. Marking a draft
 * sent twice keeps the first time, so the record can't drift.
 */
export async function markOutreachSent(prisma: PrismaClient, outreachId: string, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const outreach = await tx.outreach.findUnique({ where: { id: outreachId }, include: { business: true } });
    if (!outreach) throw new OutreachNotFoundError();

    const sent = outreach.sentAt
      ? outreach
      : await tx.outreach.update({ where: { id: outreachId }, data: { sentAt: now } });

    const lead = outreach.business;
    const notYetContacted = lead.crmStage === "NEW" || lead.crmStage === "QUALIFIED";
    const followUp = new Date(`${followUpDay(now)}T00:00:00.000Z`);
    followUp.setUTCDate(followUp.getUTCDate() + FOLLOW_UP_AFTER_DAYS);

    const business = await tx.business.update({
      where: { id: lead.id },
      data: {
        ...(notYetContacted ? { crmStage: "CONTACTED" } : {}),
        ...(lead.followUpAt ? {} : { followUpAt: followUp }),
      },
    });
    if (notYetContacted) {
      await tx.stageChange.create({ data: { businessId: lead.id, fromStage: lead.crmStage, toStage: "CONTACTED" } });
    }
    return { outreach: sent, business };
  });
}

/**
 * Leads to get back to on or before `through` (a follow-up day, as
 * parseFollowUpDay returns it), oldest first. Dead leads are left out: their
 * follow-up no longer means anything.
 */
export async function dueFollowUps(prisma: PrismaClient, through: Date) {
  const dayAfter = new Date(through);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  return prisma.business.findMany({
    where: { followUpAt: { lt: dayAfter }, crmStage: { not: "DEAD" } },
    orderBy: [{ followUpAt: "asc" }, { score: "desc" }],
    select: {
      id: true,
      name: true,
      crmStage: true,
      followUpAt: true,
      phone: true,
      email: true,
      campaign: { select: { id: true, name: true } },
    },
  });
}
