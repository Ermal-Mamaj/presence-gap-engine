import { matchPage, normalize, ownWords, type CheckResult, type CheckTarget } from "./onlineCheck";
import { safeFetchPage, SafeFetchError, type FetchedPage } from "./safeFetch";

/**
 * Small sites often aren't in any search answer, but their address is easy to
 * guess: troi-restaurant.com, posantio.com, dentalpraxis-ks.com (all three were
 * "no website" leads in the Suharekë campaign). This tries the domains the name
 * suggests, before a search is spent on the lead.
 *
 * A guessed domain proves nothing by existing: short names are taken all over
 * the world, and many are parked. It counts as found only when the lead's own
 * phone number is on it, and as unsure when its name is there with its street
 * or town. One failure is worth a look: the whole name with the country's own
 * ending (dentalpraxis-ks.com) answering with a certificate problem, which
 * browsers often get past. Any other failure is no evidence.
 */

/** Most domains tried for one lead. */
export const MAX_GUESSES = 24;
const CONCURRENCY = 6;

/** What local businesses add to a name that is taken, and the endings they use, by country. */
const COUNTRIES: { match: RegExp; suffixes: string[]; endings: string[] }[] = [
  { match: /kosov/, suffixes: ["-ks", "ks"], endings: [".com", ".net"] },
  { match: /albani|shqiperi/, suffixes: ["-al", ""], endings: [".al", ".com"] },
  { match: /macedonia|maqedoni/, suffixes: ["-mk", ""], endings: [".mk", ".com"] },
];

/** Every way to write the words as one label: run together, and with hyphens. */
const labels = (words: string[]) => (words.length > 1 ? [words.join(""), words.join("-")] : words);

const ascii = (word: string) => word.replace(/[^a-z0-9]/g, "");

/** Domains the lead might use, likeliest first. Empty for a name with no word of its own. */
export function guessDomains(target: Pick<CheckTarget, "name" | "area">): string[] {
  return guesses(target).map((g) => g.domain);
}

/** `specific`: the whole name with the country's suffix or ending, which no namesake abroad would pick. */
function guesses(target: Pick<CheckTarget, "name" | "area">): { domain: string; specific: boolean }[] {
  const own = ownWords(target.name, target.area).map(ascii).filter(Boolean);
  if (own.join("").length < 4) return [];
  // The words as written, without the town and the "sh p k" of a company.
  const skip = new Set(["sh", "p", "k", "shpk", "llc", "ltd", "dr", "and", "the", "e", "i", "n"]);
  const all = normalize(target.name)
    .split(" ")
    .map(ascii)
    .filter((w) => w && !skip.has(w) && !isTown(w, target.area))
    .slice(0, 4);
  const extra = all.filter((w) => !own.includes(w));

  const bases = [
    ...labels(own.slice(0, 3)),
    ...labels(all),
    // "Troi Restaurant" and "Restaurant Troi" are both common.
    ...extra.flatMap((w) => [...labels([...own, w]), ...labels([w, ...own])]),
  ].filter((b) => b.length >= 4 && b.length <= 40);

  const country = COUNTRIES.find((c) => c.match.test(normalize(target.area)));
  const endings = country?.endings ?? [".com"];
  const suffixes = country?.suffixes.filter(Boolean) ?? [];
  const tried = new Map<string, boolean>();
  const whole = new Set(labels(all).filter((b) => b.length >= 8));
  const add = (domain: string, specific: boolean) => tried.set(domain, (tried.get(domain) ?? false) || specific);
  for (const base of new Set(bases)) add(base + endings[0], endings[0] !== ".com" && whole.has(base));
  for (const suffix of suffixes) for (const base of new Set(bases.slice(0, 4))) add(`${base}${suffix}.com`, whole.has(base));
  for (const ending of endings.slice(1)) for (const base of new Set(bases.slice(0, 4))) add(base + ending, false);
  return [...tried].slice(0, MAX_GUESSES).map(([domain, specific]) => ({ domain, specific }));
}

/** A word that is the town's own name in some inflection (Suharekë, Suhareka). */
function isTown(word: string, area: string): boolean {
  return normalize(area)
    .split(" ")
    .some((w) => w.length >= 4 && word.slice(0, 5) === w.slice(0, 5));
}

/** Tries the guessed domains; null when none of them is evidence of anything. */
export async function guessOwnSite(
  target: CheckTarget,
  deps: { fetchPage?: (url: URL) => Promise<FetchedPage> } = {}
): Promise<CheckResult | null> {
  // Without a phone to match, a guess could never be told from a namesake.
  if ((target.phone ?? "").replace(/\D/g, "").length < 8) return null;
  const fetchPage = deps.fetchPage ?? ((url: URL) => safeFetchPage(url));
  const queue = guesses(target);
  // The town only: "Kosovo" is in every shop's list of countries.
  const here = { ...target, area: target.area.split(",")[0] };
  let found: CheckResult | null = null;
  let maybe: CheckResult | null = null;

  async function worker() {
    for (let guess = queue.shift(); guess && !found; guess = queue.shift()) {
      const { domain, specific } = guess;
      let page: FetchedPage;
      try {
        // Plain http: nearly every https site redirects from it, and some small sites have no https.
        page = await fetchPage(new URL(`http://${domain}/`));
      } catch (err) {
        if (specific && err instanceof SafeFetchError && err.kind === "tls") {
          maybe ??= {
            verdict: "unsure",
            url: `https://${domain}/`,
            evidence: [`${domain}, made of its whole name, answers with a certificate problem; open it to see whether it is theirs`],
          };
        }
        continue; // otherwise not registered, parked or down: no evidence
      }
      if (page.status >= 400 || !page.isHtml) continue;
      const match = matchPage(target, { url: page.finalUrl, html: page.body });
      // A redirect to another domain (a directory, a for-sale page) isn't the guess.
      if (!match.ownDomain) continue;
      if (match.phone) found ??= { verdict: "found", url: page.finalUrl, evidence: [...match.evidence, "guessed from its name"] };
      else if (match.name && matchPage(here, { url: page.finalUrl, html: page.body }).local)
        maybe ??= {
          verdict: "unsure",
          url: page.finalUrl,
          evidence: [...match.evidence, "guessed from its name, but its phone isn't on the page"],
        };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found ?? maybe;
}
