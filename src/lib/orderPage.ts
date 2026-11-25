import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { contactChannels, normalizePhone } from "./contacts";
import { isAnyBusiness } from "./sources/anyBusiness";

/**
 * Finding shops that could use an order page: a separate product where a
 * shop's customers order from one link and the order reaches it on WhatsApp.
 *
 * Nothing here contacts anyone. It picks the leads that fit out of what scans
 * already stored, gives each its own link so a visit can be told apart, and
 * reads back, from the order page's own counts, who opened it.
 */

// Goods that go in a parcel. Food, flowers and furniture are left out: a
// courier with cash on delivery is not how they are sold.
const PARCEL_TAGS = new Set(
  ["clothes", "boutique", "fashion", "fashion_accessories", "shoes", "bag", "jewelry", "watches", "cosmetics", "perfumery", "gift", "toys", "baby_goods", "books", "pet", "sports", "mobile_phone", "fabric", "leather", "second_hand"].map(
    (v) => `shop=${v}`
  )
);

// The same in words, English and Albanian, without accents. Each matches the
// start of a word, so "butik" also finds "butiku" and "kozmetik" "kozmetike".
const PARCEL_WORDS = [
  "clothes", "clothing", "boutique", "butik", "fashion", "veshje", "rroba", "shoe", "kepuc", "jewel", "bizhuteri", "argjendari", "cosmetic", "kozmetik", "perfum", "parfum", "gift", "dhurata", "toys", "lodra", "bookshop", "bookstore", "librari", "pet shop", "phone shop", "lingerie", "watches", "handbag",
];

const plain = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const PARCEL_WORD = new RegExp(`(?:^|[^a-z0-9])(?:${PARCEL_WORDS.join("|")})`);

/** Whether a campaign's business type sells goods that go in a parcel; "unknown" when it covers several. */
export function sellsParcelGoods(niche: string): "yes" | "no" | "unknown" {
  if (isAnyBusiness(niche)) return "unknown";
  const parts = niche.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const matches = parts.filter((p) => (p.includes("=") ? PARCEL_TAGS.has(p) : PARCEL_WORD.test(plain(p)))).length;
  if (matches === 0) return parts.includes("shop=*") ? "unknown" : "no";
  return matches === parts.length ? "yes" : "unknown";
}

/** A Kosovo or Albanian mobile number, which usually has WhatsApp; a landline does not. */
export function isMobile(raw: string | null | undefined): boolean {
  const digits = normalizePhone(raw)?.replace(/\(0\)/, "").replace(/\D/g, "").replace(/^00/, "");
  return Boolean(digits && /^(?:(?:383|0)4[3-9]\d{6}|(?:355|0)6[6-9]\d{7})$/.test(digits));
}

export interface FitInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  facebook?: string | null;
  instagram?: string | null;
  websiteStatus: string;
  onlineCheck?: string | null;
  reviewCount?: number | null;
  campaign: { niche: string };
}

export interface Fit {
  points: number;
  /** Why it was picked, in words, strongest first. */
  reasons: string[];
}

/**
 * How well an order page fits a lead, or null when it doesn't: it must sell
 * goods that go in a parcel, have no website of its own on record, and be
 * reachable. Being on Instagram counts most, because that is where the
 * orders it would replace arrive today.
 */
export function orderPageFit(lead: FitInput): Fit | null {
  const sells = sellsParcelGoods(lead.campaign.niche);
  const byName = sells === "unknown" && PARCEL_WORD.test(plain(lead.name));
  if (sells === "no" || (sells === "unknown" && !byName)) return null;
  // A listing without a website, unless the web search then found one.
  if (lead.websiteStatus !== "NONE_FOUND" || lead.onlineCheck === "found") return null;
  if (contactChannels(lead).length === 0) return null;

  const rules: [boolean, number, string][] = [
    [Boolean(lead.instagram), 4, "On Instagram"],
    [isMobile(lead.phone), 3, "Mobile number, probably on WhatsApp"],
    [sells === "yes", 2, "Sells goods that go in a parcel"],
    [byName, 1, "Its name suggests goods that go in a parcel (check)"],
    [Boolean(lead.facebook), 1, "On Facebook"],
    [(lead.reviewCount ?? 0) >= 20, 1, "20 or more reviews"],
  ];
  const met = rules.filter(([ok]) => ok);
  return { points: met.reduce((sum, [, points]) => sum + points, 0), reasons: met.map(([, , reason]) => reason) };
}

/**
 * The code that marks a lead's link. Made from the lead's id, so it needs no
 * column, stays the same, and says nothing about the business to whoever
 * sees the link.
 */
export function trialCode(leadId: string): string {
  return `g${createHash("sha256").update(leadId).digest("hex").slice(0, 10)}`;
}

/** The order page's address from ORDER_PAGE_URL, or null when unset or not a plain https origin. */
export function orderPageOrigin(env: Record<string, string | undefined> = process.env): string | null {
  try {
    const url = new URL(env.ORDER_PAGE_URL ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/** The lead's own link, or null when no order page is configured. */
export function trialLink(leadId: string, env: Record<string, string | undefined> = process.env): string | null {
  const origin = orderPageOrigin(env);
  return origin ? `${origin}/?r=${trialCode(leadId)}` : null;
}

const count = z.number().int().nonnegative();
const statsSchema = z.object({
  refs: z.record(z.string(), z.object({ view: count, demo: count, demo_order: count, signup: count })),
});

export type TrialStats = z.infer<typeof statsSchema>["refs"];

const STATS_TIMEOUT_MS = 8000;

/**
 * What the order page counted for each link. `stats` is null when it isn't
 * configured or couldn't be read, and `problem` says which, so an unread
 * count is never shown as zero visits.
 */
export async function fetchTrialStats(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<{ stats: TrialStats | null; problem: string | null }> {
  const origin = orderPageOrigin(env);
  if (!origin) return { stats: null, problem: "Set ORDER_PAGE_URL to give each shop its own link." };
  const key = env.ORDER_PAGE_STATS_KEY;
  if (!key) return { stats: null, problem: "Set ORDER_PAGE_STATS_KEY to see who opened their link." };
  try {
    const res = await fetcher(`${origin}/api/stats`, {
      headers: { authorization: `Bearer ${key}` },
      // The key must not follow a redirect to another host.
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
    });
    if (res.status === 401) return { stats: null, problem: "The order page refused ORDER_PAGE_STATS_KEY." };
    if (!res.ok) return { stats: null, problem: `The order page's counts could not be read (HTTP ${res.status}).` };
    const parsed = statsSchema.safeParse(await res.json());
    return parsed.success
      ? { stats: parsed.data.refs, problem: null }
      : { stats: null, problem: "The order page's counts were not in the expected form." };
  } catch {
    return { stats: null, problem: "The order page's counts could not be read." };
  }
}

export interface Candidate extends Fit {
  leadId: string;
  name: string;
  address: string | null;
  phone: string | null;
  instagram: string | null;
  facebook: string | null;
  crmStage: string;
  campaign: { id: string; name: string };
  link: string | null;
  /** Null when the counts could not be read; all zero when nobody opened the link. */
  visits: { view: number; demo: number; demo_order: number; signup: number } | null;
}

const NO_VISITS = { view: 0, demo: 0, demo_order: 0, signup: 0 };

/** Every lead an order page fits, best first. A business found by two campaigns is listed once. */
export async function orderPageCandidates(
  prisma: PrismaClient,
  stats: TrialStats | null,
  env: Record<string, string | undefined> = process.env
): Promise<Candidate[]> {
  const leads = await prisma.business.findMany({
    where: { websiteStatus: "NONE_FOUND", crmStage: { not: "DEAD" } },
    include: { campaign: { select: { id: true, name: true, niche: true } } },
    orderBy: [{ score: "desc" }, { id: "asc" }],
  });

  const candidates: Candidate[] = [];
  for (const lead of leads) {
    const fit = orderPageFit(lead);
    if (!fit) continue;
    const code = trialCode(lead.id);
    candidates.push({
      ...fit,
      leadId: lead.id,
      name: lead.name,
      address: lead.address,
      phone: lead.phone,
      instagram: lead.instagram,
      facebook: lead.facebook,
      crmStage: lead.crmStage,
      campaign: { id: lead.campaign.id, name: lead.campaign.name },
      link: trialLink(lead.id, env),
      visits: stats ? (Object.hasOwn(stats, code) ? stats[code] : NO_VISITS) : null,
    });
  }
  // One that was already contacted or opened its link is the copy to keep.
  candidates.sort(
    (a, b) => Number(b.crmStage !== "NEW") - Number(a.crmStage !== "NEW") || (b.visits?.view ?? 0) - (a.visits?.view ?? 0)
  );
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      const phone = normalizePhone(c.phone)?.replace(/\D/g, "").slice(-8);
      const keys = [c.instagram, c.facebook, phone && `tel:${phone}`].filter((k): k is string => Boolean(k));
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    })
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
}
