import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { contactChannels, normalizePhone } from "./contacts";
import { PIPELINE } from "./crm";
import { blockCandidates } from "./mail";
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

// The same in words, without accents. English words match whole; Albanian ones
// match the start of a word, so "butik" also finds "butiku" and "butiket".
const ENGLISH = [
  "clothes", "clothing", "boutiques?", "fashion", "shoes?", "jewell?ery", "jewell?ers?", "cosmetics?", "perfumes?", "perfumery", "gifts?", "toys?", "lingerie", "watches", "handbags?", "bags", "textiles?", "accessories", "bookshops?", "bookstores?",
  "(?:book|watch|bag|sports?|baby|pet|phone|leather|fabric) (?:shop|store|goods|clothes|supplies|accessories)s?",
];
const ALBANIAN = ["butik", "veshje", "veshmbathje", "rroba", "kepuc", "bizhuteri", "argjendari", "kozmetik", "parfum", "lodra", "librari"];

// Businesses these words also describe, which sell no parcels: a boutique
// hotel, a cosmetic dentist, a shoe repairer, a library.
const NOT_A_SHOP =
  /(?:^|[^a-z0-9])(?:hotel|hostel|motel|apartment|dentist|dental|clinic|klinik|surg|kirurg|doctor|medic|ordinanc|repair|riparim|cafe|kafe|coffee|bar(?![a-z])|restaurant|restorant|school|shkoll|librar(?:y|ies|ian)|salon|sallon|estetik|wrapping|spa(?![a-z])|laundry|wholesale)/;

const plain = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const WORD_START = "(?:^|[^a-z0-9])";
const PARCEL_WORD = new RegExp(`${WORD_START}(?:(?:${ENGLISH.join("|")})(?![a-z0-9])|(?:${ALBANIAN.join("|")}))`);
// "Dhurata" is a gift, and also a common first name, so it counts in a
// business type but never in a business's own name.
const PARCEL_NICHE_ONLY = /(?:^|[^a-z0-9])dhurat/;
const ANY_SHOP = /^(?:shops?|stores?|retail|dyqan(?:e|et|i)?|shitore)$/;

function kindOfNiche(part: string): "yes" | "no" | "unknown" {
  if (part === "shop=*") return "unknown";
  if (part.includes("=")) return PARCEL_TAGS.has(part) ? "yes" : "no";
  const text = plain(part);
  if (ANY_SHOP.test(text)) return "unknown";
  if (NOT_A_SHOP.test(text)) return "no";
  return PARCEL_WORD.test(text) || PARCEL_NICHE_ONLY.test(text) ? "yes" : "no";
}

/** Whether a campaign's business type sells goods that go in a parcel; "unknown" when it covers several. */
export function sellsParcelGoods(niche: string): "yes" | "no" | "unknown" {
  if (isAnyBusiness(niche)) return "unknown";
  const kinds = new Set(niche.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean).map(kindOfNiche));
  if (kinds.size === 1) return [...kinds][0];
  return kinds.size === 0 ? "no" : "unknown";
}

function nameSuggestsParcelGoods(name: string): boolean {
  const text = plain(name);
  return PARCEL_WORD.test(text) && !NOT_A_SHOP.test(text);
}

const KOSOVO = /kosov|prishtin|pristin|prizren|\bpej[ae]\b|gjakov|ferizaj|gjilan|mitrovic|suharek|suhareke|podujev|vushtrri|rahovec|lipjan|malishev/;

/** The phone numbers in a field that may list two ("045 … / 046 …"), as digits with any country code and no trunk zero. */
function phoneNumbers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[/;,]+/)
    .map((part) => normalizePhone(part)?.replace(/\D/g, "").replace(/^00/, "").replace(/^(383|355)0/, "$1"))
    .filter((d): d is string => Boolean(d));
}

/**
 * A Kosovo or Albanian mobile number, which usually has WhatsApp; a landline
 * does not. A local "04x" number is a mobile in Kosovo and a Tirana landline
 * in Albania, so it counts only when the region is known to be in Kosovo.
 */
export function isMobile(raw: string | null | undefined, region: string): boolean {
  const inKosovo = KOSOVO.test(plain(region));
  return phoneNumbers(raw).some(
    (d) => /^(?:3834[3-9]\d{6}|3556[6-9]\d{7}|06[6-9]\d{7})$/.test(d) || (inKosovo && /^04[3-9]\d{6}$/.test(d))
  );
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
  campaign: { niche: string; region: string };
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
  const byName = sells === "unknown" && nameSuggestsParcelGoods(lead.name);
  if (sells === "no" || (sells === "unknown" && !byName)) return null;
  // A listing without a website, unless the web search then found one.
  if (lead.websiteStatus !== "NONE_FOUND" || lead.onlineCheck === "found") return null;
  if (contactChannels(lead).length === 0) return null;

  const rules: [boolean, number, string][] = [
    [Boolean(lead.instagram), 4, "On Instagram"],
    [isMobile(lead.phone, lead.campaign.region), 3, "Mobile number, probably on WhatsApp"],
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
  if (!origin) {
    const problem = env.ORDER_PAGE_URL?.trim()
      ? "ORDER_PAGE_URL was not accepted: it must be a plain https address, such as https://orders.example."
      : "Set ORDER_PAGE_URL to give each shop its own link.";
    return { stats: null, problem };
  }
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
  email: string | null;
  instagram: string | null;
  facebook: string | null;
  crmStage: string;
  campaign: { id: string; name: string };
  link: string | null;
  /** Null when the counts could not be read; all zero when nobody opened the link. */
  visits: { view: number; demo: number; demo_order: number; signup: number } | null;
}

// Past these, or dead, a lead is no prospect: it is a customer, or said no.
const PROSPECT_STAGES = ["NEW", "QUALIFIED", "CONTACTED", "REPLIED"];

type Copy = FitInput & {
  id: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  facebook: string | null;
  instagram: string | null;
  crmStage: string;
  campaign: { id: string; name: string; niche: string; region: string };
};

// Page names ignore case on both networks; only profile.php's id is kept as it is.
const pageKey = (url: string | null) => (url && !url.includes("profile.php") ? url.toLowerCase() : url);

interface Shop {
  copies: Copy[];
  instagram: Set<string>;
  facebook: Set<string>;
  phones: Set<string>;
}

const overlaps = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));

function sameShop(a: Shop, b: Shop): boolean {
  if (overlaps(a.instagram, b.instagram) || overlaps(a.facebook, b.facebook)) return true;
  // One owner's number can stand on two shops; different pages on the same network tell them apart.
  const differ = (x: Set<string>, y: Set<string>) => x.size > 0 && y.size > 0;
  if (differ(a.instagram, b.instagram) || differ(a.facebook, b.facebook)) return false;
  return overlaps(a.phones, b.phones);
}

/** Groups the copies of one shop that different campaigns found. */
function groupByShop(copies: Copy[]): Shop[] {
  const set = (value: string | null) => new Set(value ? [value] : []);
  let shops: Shop[] = [];
  // Those with the most pages first, so a copy with only a phone joins a shop already told apart.
  const pages = (c: Copy) => Number(Boolean(c.instagram)) + Number(Boolean(c.facebook));
  for (const copy of [...copies].sort((a, b) => pages(b) - pages(a))) {
    const merged: Shop = {
      copies: [copy],
      instagram: set(pageKey(copy.instagram)),
      facebook: set(pageKey(copy.facebook)),
      phones: new Set(phoneNumbers(copy.phone).map((d) => d.slice(-8))),
    };
    const others: Shop[] = [];
    for (const shop of shops) {
      if (!sameShop(shop, merged)) {
        others.push(shop);
        continue;
      }
      merged.copies.unshift(...shop.copies);
      for (const key of ["instagram", "facebook", "phones"] as const) shop[key].forEach((v) => merged[key].add(v));
    }
    shops = [...others, merged];
  }
  return shops;
}

/**
 * Every shop an order page fits, best first, each listed once however many
 * campaigns found it. What one copy knows counts for all of them: a shop that
 * said no, became a customer, opted out or has a website in one campaign is
 * not offered through another.
 */
export async function orderPageCandidates(
  prisma: PrismaClient,
  stats: TrialStats | null,
  env: Record<string, string | undefined> = process.env
): Promise<Candidate[]> {
  const [leads, blockedRows] = await Promise.all([
    prisma.business.findMany({
      include: { campaign: { select: { id: true, name: true, niche: true, region: true } } },
      orderBy: [{ score: "desc" }, { id: "asc" }],
    }),
    prisma.doNotContact.findMany({ select: { value: true } }),
  ]);
  const blocked = new Set(blockedRows.map((b) => b.value));
  const optedOut = (c: Copy) => Boolean(c.email) && blockCandidates(c.email!).some((v) => blocked.has(v));
  const visitsOf = (c: Copy) => {
    const code = trialCode(c.id);
    return stats && Object.hasOwn(stats, code) ? stats[code] : { view: 0, demo: 0, demo_order: 0, signup: 0 };
  };
  const stage = (c: Copy) => {
    const at = PIPELINE.findIndex((s) => s === c.crmStage);
    return at >= PIPELINE.indexOf("CONTACTED") ? at : 0; // NEW and QUALIFIED: not contacted yet
  };

  const candidates: Candidate[] = [];
  for (const { copies } of groupByShop(leads)) {
    const ruledOut = (c: Copy) =>
      !PROSPECT_STAGES.includes(c.crmStage) || c.websiteStatus !== "NONE_FOUND" || c.onlineCheck === "found" || optedOut(c);
    if (copies.some(ruledOut)) continue;

    // The copy furthest along is the one shown; its link is the one already sent.
    const ranked = [...copies].sort((a, b) => stage(b) - stage(a) || visitsOf(b).view - visitsOf(a).view);
    const [main] = ranked;
    const first = <T>(pick: (c: Copy) => T | null | undefined) => ranked.map(pick).find(Boolean) ?? null;
    const contacts = {
      phone: ranked.find((c) => isMobile(c.phone, c.campaign.region))?.phone ?? first((c) => c.phone),
      email: first((c) => c.email),
      instagram: first((c) => c.instagram),
      facebook: first((c) => c.facebook),
      reviewCount: Math.max(...ranked.map((c) => c.reviewCount ?? 0)),
    };
    const fit = ranked
      .map((c) => orderPageFit({ ...c, ...contacts }))
      .filter((f): f is Fit => f !== null)
      .sort((a, b) => b.points - a.points)[0];
    if (!fit) continue;

    candidates.push({
      ...fit,
      leadId: main.id,
      name: main.name,
      address: main.address ?? first((c) => c.address),
      phone: contacts.phone,
      email: contacts.email,
      instagram: contacts.instagram,
      facebook: contacts.facebook,
      crmStage: main.crmStage,
      campaign: { id: main.campaign.id, name: main.campaign.name },
      link: trialLink(main.id, env),
      visits: stats
        ? ranked.map(visitsOf).reduce((sum, v) => ({
            view: sum.view + v.view,
            demo: sum.demo + v.demo,
            demo_order: sum.demo_order + v.demo_order,
            signup: sum.signup + v.signup,
          }))
        : null,
    });
  }
  return candidates.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
}
