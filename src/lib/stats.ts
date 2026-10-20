import type { PrismaClient } from "@/generated/prisma/client";
import { PIPELINE } from "./crm";
import { furthestStage } from "./pipeline";

/**
 * What works: how many of the leads written to replied, split by the message
 * template of the first message sent, the channel it went out on, and the
 * campaign's business type. A lead counts once, under the first message it
 * was sent, and as replied if it ever reached REPLIED (see furthestStage), so
 * a reply that was followed by "not interested" still counts as a reply.
 */

export interface Tally {
  /** Leads whose first message was sent. */
  sent: number;
  replied: number;
  converted: number;
  /** replied / sent; null with nothing sent. */
  replyRate: number | null;
}

export interface TemplateTally extends Tally {
  /** Null for messages written without a template, or whose template has since been deleted. */
  templateId: string | null;
  label: string;
}

export interface OutreachStats {
  sent: number;
  byTemplate: TemplateTally[];
  byChannel: ({ channel: string } & Tally)[];
  byNiche: ({ niche: string } & Tally)[];
}

const REPLIED = PIPELINE.indexOf("REPLIED");
const CONVERTED = PIPELINE.indexOf("CONVERTED");

function tally(leads: { replied: boolean; converted: boolean }[]): Tally {
  const replied = leads.filter((l) => l.replied).length;
  return {
    sent: leads.length,
    replied,
    converted: leads.filter((l) => l.converted).length,
    replyRate: leads.length > 0 ? replied / leads.length : null,
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Best reply rate first, then the most sent. */
const byResults = (a: Tally, b: Tally) => (b.replyRate ?? -1) - (a.replyRate ?? -1) || b.sent - a.sent;

export async function outreachStats(prisma: PrismaClient, campaignId?: string): Promise<OutreachStats> {
  const leads = await prisma.business.findMany({
    where: { ...(campaignId ? { campaignId } : {}), outreach: { some: { sentAt: { not: null } } } },
    select: {
      crmStage: true,
      stageChanges: { select: { fromStage: true, toStage: true }, orderBy: { createdAt: "asc" } },
      campaign: { select: { niche: true } },
      outreach: {
        where: { sentAt: { not: null } },
        orderBy: { sentAt: "asc" },
        take: 1,
        select: { channel: true, template: { select: { id: true, gapKey: true, channel: true, language: true, body: true } } },
      },
    },
  });

  const rows = leads.map((lead) => {
    const first = lead.outreach[0];
    const reached = furthestStage(lead);
    return {
      replied: reached >= REPLIED,
      converted: reached >= CONVERTED,
      channel: first.channel,
      niche: lead.campaign.niche.trim().toLowerCase(),
      template: first.template,
    };
  });

  const byTemplate = [...groupBy(rows, (r) => r.template?.id ?? "none")].map(([id, group]): TemplateTally => {
    const template = group[0].template;
    return {
      templateId: template ? id : null,
      label: template
        ? `${template.gapKey} · ${template.channel} · ${template.language}: ${template.body.replace(/\s+/g, " ").slice(0, 50)}`
        : "No template (written by hand or by AI, or the template was deleted)",
      ...tally(group),
    };
  });

  return {
    sent: rows.length,
    byTemplate: byTemplate.sort(byResults),
    byChannel: [...groupBy(rows, (r) => r.channel)].map(([channel, group]) => ({ channel, ...tally(group) })).sort(byResults),
    byNiche: [...groupBy(rows, (r) => r.niche)].map(([niche, group]) => ({ niche, ...tally(group) })).sort(byResults),
  };
}
