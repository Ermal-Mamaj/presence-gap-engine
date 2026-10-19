import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { contactChannels } from "./contacts";
import { fromStoredSignal } from "./detect";
import { citableSignals } from "./outreach";

/**
 * The review queue: one card per lead, grouped by what it needs next. A lead
 * is sent to only after a person has read its message here, so this is where
 * drafting ends and outreach starts.
 */

export interface ReviewCard {
  leadId: string;
  name: string;
  address: string | null;
  score: number;
  crmStage: string;
  /** The most severe verified gap, the one a draft is written about. */
  topGap: string | null;
  phone: string | null;
  email: string | null;
  emailFromSite: boolean;
  /** The email, or its whole domain, is on the do-not-contact list. */
  doNotContact: boolean;
  facebook: string | null;
  instagram: string | null;
  followUpAt: Date | null;
  draft: {
    id: string;
    channel: string;
    subject: string | null;
    body: string;
    sentAt: Date | null;
    fromTemplate: boolean;
    createdAt: Date;
  } | null;
}

export interface ReviewQueue {
  /** The latest draft is written and not yet sent. */
  ready: ReviewCard[];
  /** Has something verified to say and a way to be reached, but no draft. */
  needsDraft: ReviewCard[];
  /** The latest draft has gone out. */
  sent: ReviewCard[];
}

export async function reviewQueue(prisma: PrismaClient, campaignId: string): Promise<ReviewQueue> {
  const leads = await prisma.business.findMany({
    where: { campaignId, crmStage: { not: "DEAD" } },
    include: { signals: true, outreach: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { score: "desc" },
  });

  const blocked = new Set((await prisma.doNotContact.findMany({ select: { value: true } })).map((b) => b.value));
  const onList = (email: string | null) =>
    Boolean(email) && (blocked.has(email!.toLowerCase()) || blocked.has(email!.toLowerCase().split("@")[1] ?? ""));

  const queue: ReviewQueue = { ready: [], needsDraft: [], sent: [] };
  for (const lead of leads) {
    const gaps = citableSignals(lead.signals.map(fromStoredSignal)).sort((a, b) => b.severity - a.severity);
    const latest = lead.outreach[0];
    const card: ReviewCard = {
      leadId: lead.id,
      name: lead.name,
      address: lead.address,
      score: lead.score,
      crmStage: lead.crmStage,
      topGap: gaps[0]?.label ?? null,
      phone: lead.phone,
      email: lead.email,
      emailFromSite: lead.emailFromSite,
      doNotContact: onList(lead.email),
      facebook: lead.facebook,
      instagram: lead.instagram,
      followUpAt: lead.followUpAt,
      draft: latest
        ? {
            id: latest.id,
            channel: latest.channel,
            subject: latest.subject,
            body: latest.body,
            sentAt: latest.sentAt,
            fromTemplate: latest.templateId !== null,
            createdAt: latest.createdAt,
          }
        : null,
    };
    if (latest?.sentAt) queue.sent.push(card);
    else if (latest) queue.ready.push(card);
    else if (gaps.length && contactChannels(lead).length && ["NEW", "QUALIFIED"].includes(lead.crmStage)) {
      queue.needsDraft.push(card);
    }
  }
  queue.sent.sort((a, b) => b.draft!.sentAt!.getTime() - a.draft!.sentAt!.getTime());
  return queue;
}

export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft not found");
    this.name = "DraftNotFoundError";
  }
}

export class DraftAlreadySentError extends Error {
  constructor() {
    super("This draft has been sent, so its text is kept as it went out.");
    this.name = "DraftAlreadySentError";
  }
}

export const draftEditSchema = z.object({
  subject: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => v || null),
  body: z.string().trim().min(1, "The message can't be empty").max(5000),
});

/**
 * Saves a person's edits to a draft before it is sent. A sent draft is the
 * record of what went out, so it can't be changed afterwards.
 */
export async function editDraft(prisma: PrismaClient, id: string, edit: z.infer<typeof draftEditSchema>) {
  const result = await prisma.outreach.updateMany({
    where: { id, sentAt: null },
    data: { subject: edit.subject, body: edit.body, openLine: edit.body.split("\n")[0].trim() },
  });
  if (result.count === 1) return prisma.outreach.findUniqueOrThrow({ where: { id } });
  const exists = await prisma.outreach.findUnique({ where: { id }, select: { id: true } });
  throw exists ? new DraftAlreadySentError() : new DraftNotFoundError();
}
