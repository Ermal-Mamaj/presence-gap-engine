import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { fromStoredSignal } from "./detect";
import { citableSignals, OutreachError } from "./outreach";
import { isAnyBusiness } from "./sources/anyBusiness";
import {
  CHANNEL_LABEL,
  DEFAULT_LANGUAGE,
  DRAFT_CHANNELS,
  DRAFT_LANGUAGES,
  type DraftChannel,
  type DraftLanguage,
  isDraftLanguage,
} from "./outreachOptions";
import { fillTemplate, isTemplateGap, TEMPLATE_GAPS, type TemplateGap, templateProblems } from "./templateText";

/**
 * Drafts come from templates written by a person, not generated: correct in
 * the language by construction, free, and unable to state anything the scan
 * didn't verify, because the only facts a template can carry are the
 * placeholders and the gap it was written for.
 */

export type LeadForDraft = Prisma.BusinessGetPayload<{ include: { signals: true; campaign: true } }>;

export class TemplateNotFoundError extends Error {
  constructor() {
    super("Template not found");
    this.name = "TemplateNotFoundError";
  }
}

const languages = Object.keys(DRAFT_LANGUAGES) as [DraftLanguage, ...DraftLanguage[]];
const gaps = Object.keys(TEMPLATE_GAPS) as [TemplateGap, ...TemplateGap[]];

/** What the editor sends: the whole template, every time. */
export const templateInputSchema = z
  .object({
    language: z.enum(languages),
    channel: z.enum(DRAFT_CHANNELS),
    gapKey: z.enum(gaps),
    // Matched against the campaign's niche, ignoring case; empty = any business type.
    niche: z
      .string()
      .trim()
      .max(100)
      .nullable()
      .optional()
      .transform((v) => (v ? v.toLowerCase() : null)),
    subject: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .transform((v) => v || null),
    body: z.string().trim().min(1, "The message can't be empty").max(3000),
    active: z.boolean().optional().default(true),
  })
  .superRefine((v, ctx) => {
    for (const message of templateProblems(v.subject, v.body)) ctx.addIssue({ code: "custom", message });
    if (v.channel === "email" && !v.subject) {
      ctx.addIssue({ code: "custom", message: "An email template needs a subject line" });
    }
  });

export type TemplateInput = z.infer<typeof templateInputSchema>;

/** Every template, with how many drafts each has produced. */
export function listTemplates(prisma: PrismaClient) {
  return prisma.messageTemplate.findMany({
    orderBy: [{ language: "asc" }, { channel: "asc" }, { gapKey: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { outreach: true } } },
  });
}

export function createTemplate(prisma: PrismaClient, input: TemplateInput) {
  return prisma.messageTemplate.create({ data: input });
}

export async function updateTemplate(prisma: PrismaClient, id: string, input: TemplateInput) {
  const result = await prisma.messageTemplate.updateMany({ where: { id }, data: input });
  if (result.count === 0) throw new TemplateNotFoundError();
  return prisma.messageTemplate.findUniqueOrThrow({ where: { id } });
}

/** Drafts already made from it keep their text; only their link to it is cleared. */
export async function deleteTemplate(prisma: PrismaClient, id: string) {
  const result = await prisma.messageTemplate.deleteMany({ where: { id } });
  if (result.count === 0) throw new TemplateNotFoundError();
}

export interface TemplateDraft {
  templateId: string;
  gapKey: TemplateGap;
  subject: string | null;
  body: string;
}

/**
 * The draft for a lead from the best template that fits, or an error saying
 * which template is missing.
 *
 * The gap is the lead's most severe verified one that has a template. Among
 * templates for that gap, one written for the campaign's business type beats
 * a generic one, and a template that needs a value the lead lacks is passed
 * over. Of the rest, the one used least in this campaign wins, so variants
 * rotate and neighbouring businesses don't receive the same text.
 */
export async function draftFromTemplate(
  prisma: PrismaClient,
  lead: LeadForDraft,
  channel: DraftChannel
): Promise<TemplateDraft> {
  const language = isDraftLanguage(lead.campaign.language) ? lead.campaign.language : DEFAULT_LANGUAGE;
  const citable = citableSignals(lead.signals.map(fromStoredSignal)).sort((a, b) => b.severity - a.severity);
  const gapOrder = [...new Set(citable.map((s) => s.key).filter(isTemplateGap))];
  if (gapOrder.length === 0) {
    throw new OutreachError(
      "no_verified_gaps",
      "This lead has no verified gap to mention yet. Check its website first, then draft."
    );
  }

  const niche = lead.campaign.niche.trim().toLowerCase();
  const candidates = await prisma.messageTemplate.findMany({
    where: { language, channel, active: true, gapKey: { in: gapOrder }, OR: [{ niche: null }, { niche }] },
    orderBy: { createdAt: "asc" },
  });
  const usage = new Map(
    (
      await prisma.outreach.groupBy({
        by: ["templateId"],
        where: { templateId: { in: candidates.map((t) => t.id) }, business: { campaignId: lead.campaignId } },
        _count: { _all: true },
      })
    ).map((row) => [row.templateId, row._count._all])
  );

  const values = {
    name: lead.name,
    // "Anything" isn't a business type: a template that names one is skipped for that campaign.
    business_type: isAnyBusiness(lead.campaign.niche) ? null : lead.campaign.niche,
    area: lead.campaign.region,
    website: lead.website,
  };

  for (const gapKey of gapOrder) {
    const fitting = candidates
      .filter((t) => t.gapKey === gapKey)
      .map((t) => ({ t, subject: t.subject ? fillTemplate(t.subject, values) : null, body: fillTemplate(t.body, values) }))
      .filter((c) => c.body !== null && (c.t.subject === null || c.subject !== null))
      // Written for this business type first, then least used here, then oldest.
      .sort(
        (a, b) =>
          Number(b.t.niche !== null) - Number(a.t.niche !== null) ||
          (usage.get(a.t.id) ?? 0) - (usage.get(b.t.id) ?? 0)
      );
    const chosen = fitting[0];
    if (chosen) return { templateId: chosen.t.id, gapKey, subject: chosen.subject, body: chosen.body! };
  }

  const top = gapOrder[0];
  throw new OutreachError(
    "no_template",
    `No ${DRAFT_LANGUAGES[language]} ${CHANNEL_LABEL[channel].toLowerCase()} template fits this lead yet. ` +
      `Its main gap is "${TEMPLATE_GAPS[top]}"; add a template for it under Templates.`
  );
}
