# Presence Gap Engine

[![CI](https://github.com/Ermal-Mamaj/presence-gap-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/Ermal-Mamaj/presence-gap-engine/actions/workflows/ci.yml)

Find businesses with a visibly weak or missing web presence, prove you noticed
something specific and real about them, offer to fix it, deliver the work,
then keep them around.

This app covers stages 1–6 of that pipeline as a working tool:

1. **Target box** — a campaign is one region + one niche (e.g. "dentists in Tirana").
2. **Find** — pulls a raw business list from a source adapter (`src/lib/sources`).
3. **Detect the gap** — checks each business for publicly observable signals: no website, unreachable site, no HTTPS, no mobile viewport tag, stale copyright year, thin/no reviews (`src/lib/detect.ts`). Every signal is marked `VERIFIED` or `UNCERTAIN`, and each business gets a website status: `NONE_FOUND`, `NEEDS_WORK`, `NEEDS_CHECK` or `GOOD`.
4. **Qualify and rank** — combines gap severity with signs of a viable business (reviews, rating, phone) into a score from 0 to 100, and penalizes likely-ghost listings (`src/lib/score.ts`).
5. **Reach out** — fills in a draft per lead from a **message template** written by a person (`/templates`, `src/lib/templates.ts`), for the lead’s most severe verified gap, its campaign’s language and the chosen channel. Templates may use `{{name}}`, `{{business_type}}`, `{{area}}` and `{{website}}`; one written for the campaign’s business type beats a generic one, one needing a value the lead lacks is skipped, and variants rotate, least used in the campaign first. With no fitting template the draft is refused with a message naming what is missing, never improvised. The templates page shows which gap and channel combinations still need one. `DRAFT_SOURCE=claude` switches back to drafts written by the Claude API (`src/lib/outreach.ts`). Each campaign has a draft language (Albanian, English, Italian, German, Greek, Serbian or Macedonian; new campaigns suggest Albanian, existing ones stay English), and each draft is for one channel: an email, a script for a phone call, or a WhatsApp/Facebook message. The channel defaults to one the lead can be reached on, email first, and every draft records which it was for.
   **Draft top 10** on a campaign (`POST /api/campaigns/<id>/drafts`, `src/lib/drafting.ts`) drafts the highest-scoring leads that are ready for a first message (a verified gap to mention, no draft yet, stage NEW or QUALIFIED), up to 20 at a time, three in parallel. One lead's failure doesn't stop the rest; missing credentials stop it at once.
6. **Convert / retain** — each lead has a CRM stage (New → Qualified → Contacted → Replied → Converted → Delivered → Retained / Dead) and a notes field, tracked per business.

Stages 7–8 (fulfillment, hosting/upkeep, upsell) are operational, not
software — this tool ends at "you have a ranked list of the right businesses
with a drafted, specific message."

## Data sources

Two pluggable sources behind a common interface (`src/lib/sources/types.ts`):

- **OpenStreetMap** (`OSM`, default, recommended) — free, uses Nominatim to
  geocode the region and the Overpass API to query businesses by OSM tag. No
  ToS risk, but coverage and data completeness (websites, phone numbers)
  vary a lot by region, since it depends on what's been mapped.
  Both services are shared and often busy, so the client
  (`src/lib/sources/osmClient.ts`) is polite and patient: Nominatim gets at
  most one request per second across the app, with each region cached for a
  day and asked for only once when several scans want it, as its usage
  policy asks; a busy Nominatim is tried once more. An Overpass query that
  the main instance turns away (busy, rate-limited, unreachable) goes to a
  mirror, then both are retried after 15s and 45s, or later if a server's
  `Retry-After` asks for it, all within 150 seconds. A server's final answer
  (a 400, a moved endpoint) drops only that server. A query too heavy for
  every server fails at once, suggesting a smaller region, since waiting
  won't help. Set `OVERPASS_URLS` (comma-separated) to use other instances.
- **Google Maps scraper** (`GOOGLE_MAPS_SCRAPER`, experimental) — uses
  Playwright to scrape Google Maps search results and each listing's detail
  pane for name, address, phone, website, rating, and review count.
  **This violates Google's Terms of Service.** It also depends on Google's
  unversioned DOM, so it can break at any time, and Google may rate-limit or
  block the IP running it. It's included because it gives much richer data
  (most OSM entries lack a `website` tag even when the business has one),
  but keep volumes small and infrequent if you use it. The code is capped at
  40 listings per run by design (100 for *anything*, below). It needs a
  Chromium browser: set `PLAYWRIGHT_CHROMIUM_PATH` to an installed Chrome or
  Edge (`C:/Program Files/Google/Chrome/Application/chrome.exe` on Windows).

**Several places in one campaign:** the region may name up to 5 places separated by semicolons (`Suharekë, Kosovo; Rahovec, Kosovo`; a comma stays part of one place’s name). Each is searched in turn by the same source, the results are combined, and a business found in two places is one lead. The scan takes about that many times as long, and its progress lines name the place. If a place can’t be searched but another gets through, the scan succeeds and the scan history says which one is missing (run again to retry); if none gets through, it fails and says why for each. A single place behaves as before.

A scan that takes minutes says what it is doing: the campaign page shows a line such as *Searching "cafe in Suharek" (5/24)* or *Opening new places 12/60 (40 already known, not reopened)*, and every message also refreshes the scan’s claim, so a long search is never mistaken for a crashed scan. On a **re-scan** the Google Maps source skips opening places the campaign already has (matched by Google’s stable place id): the list shows enough to mark them seen again, their saved phone, website and address stay, and only new places cost a page load. To refresh a known place’s details, delete the lead and scan again.

The niche is either a term the OSM adapter knows (about 65, from "dentist" to "driving school", plural accepted) or, for any other business type, OpenStreetMap tags given directly: `shop=optician`, or up to five separated by commas. Tags are validated before they reach the Overpass query.

**Anything** (also *any business*, *all*, *çdo biznes*, *të gjitha*) is every common kind of local business at once (`src/lib/sources/anyBusiness.ts`), for a campaign that wants a whole town. On Google Maps it runs one search per common type (24, from restaurants to driving schools; banks, fuel stations and chains are left out), reads up to 8 places from each, and opens at most 100, taken from each search in turn so every type is represented, each place once however many searches found it. On OpenStreetMap it asks for every named shop, craft and office and the amenities worth a pitch, up to 400. Before this, *Anything* went to Google as typed and found 7 places in Suharekë.

Adding a new source means implementing `BusinessSource` in
`src/lib/sources/` and registering it in `src/lib/sources/index.ts` — nothing
else in the pipeline needs to change.

## How scans behave

A campaign's scan (`src/lib/scan.ts`) is built so that running it again can never make things worse:

- **Nothing is deleted.** Discovery and website checks run in memory first. Results are then applied in one database transaction that only creates or updates leads, so a failed or partial scan leaves earlier leads untouched. Leads, their CRM stage, notes, outreach drafts and stage history are never removed by a scan.
- **Reruns update in place.** A lead's identity is its source id (or, without one, its normalized name + address), enforced by a unique key per campaign (`src/lib/dedupe.ts`). A rerun refreshes the data and replaces the lead's gap signals; it does not add duplicates. A value the source stops reporting is kept rather than erased.
- **Each scan is recorded** as a `ScanRun` (status, found/created/updated/skipped counts, error). `Campaign.status` reflects the latest scan; a `FAILED` campaign still shows the leads from its last good scan.
- **One scan at a time per campaign.** The campaign is claimed with a single atomic update; a second request gets HTTP 409. A running scan refreshes its claim as websites are checked, so a slow scan is never mistaken for a crashed one; a scan that makes no progress for 15 minutes is considered abandoned and can be rerun.
- **The scan outlives its request.** `POST /api/campaigns/<id>/run` claims the
  campaign, answers `202 Accepted` with the `ScanRun` id, and runs the scan via
  Next's `after` once the response is sent; the page then polls the campaign
  until it leaves `RUNNING`. Checking 60 websites takes minutes, and the scan
  used to run inside the request, so a long one outlived it: the work finished
  and `ScanRun` recorded it, but the browser lost the answer. The claim stays
  synchronous because it decides the status code (404, 409). You can leave the
  page while a scan runs. Note that `after` runs within the route's max
  duration, so a serverless host still caps it — `maxDuration` is set to 300s
  where the platform honours it, and a run killed mid-flight is reclaimed by the
  staleness rule above.
- **Where it runs.** The supported setup is a long-running Node server
  (`next start`, or the same in Docker). There `after` is fully supported and
  no platform time limit applies, since `maxDuration` is a hint that
  deployment platforms read, not something `next start` enforces. Stopping the
  server only waits a short drain period for pending `after` work, so a
  restart mid-scan abandons that scan, and the staleness rule frees the
  campaign. Serverless hosts are not supported as-is: the SQLite file does not
  survive there, and after moving to Postgres (see Setup) a scan still has to
  fit the platform's limit. Static export cannot work, because the app needs
  its API routes.
- **Website checks are capped, leads are not.** A scan fetches at most 60
  websites, because a check can take seconds, but a lead without a website
  costs no request, so every lead the source returns is saved. OpenStreetMap
  returns up to 200 per query. Websites over the limit wait for the next
  scan, which checks never-checked sites first and then the least recently
  checked, so a large campaign is covered over a few scans. A deferred site
  that was checked before keeps that result; one that never was reads *Website
  not checked yet*. The lead page says when its website was last checked, and
  scan history counts the deferred sites. Until now a campaign was cut at 60
  leads in whatever order the source returned them: about 20 of 80 dentists
  in Tirana were never scored.
- **Bad records are skipped, not fatal.** A record without a name is dropped; an impossible field (a rating of 47) becomes "unknown". If a source returns records but none are usable, the scan fails instead of silently saving nothing. An empty result is a valid result.

## Contact details

A drafted email needs someone to send it to, so a scan keeps every way to
reach a business that it can find (`src/lib/contacts.ts`):

- **From the listing.** Phone (falling back to a mobile number), email,
  Facebook and Instagram, under either OSM spelling (`email` or
  `contact:email`). The values are free text, so they are normalized: the
  first usable address in "a; b", a profile link from a bare page name, and
  share buttons, other hosts and malformed values dropped.
- **From the business's own site.** When a website check reads a real page,
  its first `mailto:` and `tel:` links fill in an email or phone the listing
  left out. They never override the listing, and an error page is never read.
- **Kept across scans.** As with other fields, a contact a later scan no longer
  finds is kept rather than erased.

Coverage is thin, which is the point of showing it. In a sample of 80 dentists
in Tirana on OpenStreetMap, 10 listed a phone, 7 an email and 3 a Facebook
page. A lead with nothing to go on gets a web-search link on its page.

## The online check

A business with no website on OpenStreetMap often has one. **Check offline leads online** on a campaign (`src/lib/onlineCheck.ts`) searches the web for up to 20 leads whose site status is *None listed*, one at a time, through Groq’s `browser_search`, OpenRouter’s web plugin on a free model, or Tavily, each with its own key (`.env.example`). With more than one key set, they go in that order (`ONLINE_CHECK_PROVIDER` can name the first): when one hits its rate limit or runs out of credits, the next takes over, and the first is tried again when it said to (a minute if it didn’t). A rejected key is skipped for the rest of the run. Groq’s free plan allows 8,000 tokens a minute and 200,000 a day, and one search takes 4,000–8,000, so it covers about one lead a minute and 25–30 a day. OpenRouter’s free models allow about 50 requests a day on an account without credits; an account with no credits can’t be charged.

The search only suggests pages: directories, maps and social sites are dropped, and up to five candidates, those on a domain made of the lead’s name first, are fetched through the same guarded fetcher as website checks and matched against the lead: its phone (last 8 digits, however written), its name, and its street or city. Generic words ("Klinika", "Dental") and the city’s name don’t count as the name, and a name made only of them ("Klinikë Dentare") never matches. The verdict, with its evidence, is shown on the lead:

- **Found:** a page on a domain made of its name (`arberi.al` for Arbëri) shows its phone, or its name and its street or city. The page becomes the lead’s website, *No website found* is no longer claimed, and the next scan checks the site like any other. An unsent draft written before is flagged on its review card.
- **Not online:** nothing matched; the lead really looks offline.
- **Unsure,** flagged for a person to look at: the phone or name and street are on a page elsewhere (often a directory listing; no list of directories is complete); a namesake domain doesn’t mention the street or city (MonDent in Tirana vs. `mondent.ba` in Bosnia); a site named after the lead didn’t load (perhaps its old site); or its name and street or city are on some page.

A verdict is reused for 30 days. A rate-limited search is retried up to three times, after the wait the provider asked for (20 seconds if it didn’t say, at most 65); if it is still limited, the run stops and says why, keeping the verdicts so far.

These rules come from live runs on Tirana dentists listed with no website, each of which caught a wrong answer: listings on `exa.ai` and `geoview.info` taken as the site, `mondent.ba`, "Dentist ne Tirane" matching through the city, and a generic name matching another clinic.

## Website checks and certainty

Business websites come from data anyone can edit, so `src/lib/safeFetch.ts` treats every URL as hostile: http(s) only, no credentials, only ports 80/443/8080/8443, every resolved IP checked at connect time (loopback, private, link-local, carrier-grade NAT, multicast, reserved and the IPv6/NAT64/6to4 equivalents are refused), redirects followed manually and re-validated per hop (max 5), one total deadline of 8 seconds covering the body, a 1 MiB size cap that also applies after decompression, and at most 8 requests in flight process-wide. Pages are read as text and never executed.

Some listings have no site of their own even though the website field is filled: a Facebook, Instagram, Linktree, WhatsApp or TikTok link counts as *Uses a social media page instead of a website* (35), and a `*.business.site` address as a Google Business Profile site, which Google shut down in 2024 (40). These are decided from the URL alone, nothing is fetched, the lead reads *None listed*, and a Facebook or Instagram link also fills that contact. On a page that does load, a parked or for-sale domain is reported as such (35) and nothing else on it is judged, since the page belongs to a registrar; a missing meta description (5) and, for a business with a phone, no tap-to-call `tel:` link on a fully read homepage (5) are small, verified talking points.

A failed request is **not** proof of a gap. Network errors, timeouts, TLS failures and HTTP 401/403/429/5xx are recorded as `UNCERTAIN` (and retried once if transient); only a 404/410, a missing viewport tag, plain HTTP and a stale footer on a fully-read page are `VERIFIED`. A missing `website` field is recorded as "No website found", meaning *the listing has none*. OpenStreetMap often omits websites that exist, so treat that as a lead to check, not a fact. Outreach drafts only cite `VERIFIED` signals.

## Scoring

`score = gap points × viability multiplier`, clamped to 0–100 (`src/lib/score.ts`; `explainScore` returns every term).

- **Gap points** are the sum of signal severities (no website 40, unreachable 35, HTTP error 30, TLS problem 25, no HTTPS 15, no mobile viewport 15, stale site 10, thin listing 10). An `UNCERTAIN` signal counts for half: one failed request makes a lead worth a look, but is not proof. This 0.5 is a judgement call, not a measured value.
- **Viability multiplier** is 1 plus up to 0.6 for review volume (log scale, full credit at 200 reviews), up to 0.3 for rating, and 0.1 for each distinct way to reach the business: phone, email, and a social profile (Facebook and Instagram together count once), so up to 0.3. A lead nobody can contact can't convert, and since OpenStreetMap reports no reviews or ratings, reachability is the only viability evidence most OSM leads have. Before it counted, OSM leads with the same gap scored either 40 or 44, so the ranking was mostly a tie. The 0.1 is a judgement call, like the 0.5 below; review and rating weights are unchanged from the original model.
- **Unknown is not zero.** A review count or rating the source never reported earns no credit but is not evidence of an empty listing. A *reported* 0 reviews / unrated listing with no way to reach it is treated as a likely ghost and halved. Likewise "little to no reviews" is only flagged when the source actually reports review data (OpenStreetMap never does).
- Invalid inputs (a rating outside 0–5, negative or non-finite counts or severities) are ignored, so the score is always finite and within range.
- **Rescoring needs no rescan.** A score is stored when a scan runs. After changing a weight, **Recalculate scores** on a campaign (`POST /api/campaigns/<id>/rescore`, `src/lib/rescore.ts`) recomputes every lead from its stored signals and listing fields without fetching anything, and writes nothing but the score.

## Managing campaigns

A campaign can be renamed and its draft language changed from its page (`PATCH /api/campaigns/<id>`). Region, niche and source stay fixed, since they define what was scanned. **Delete campaign** (`DELETE /api/campaigns/<id>`) removes the campaign with every lead, draft, note, stage history and scan in it, after a confirmation that says how many leads have been worked. It is refused while a scan is running, checked in the same statement that deletes, unless that scan has been silent past the 15-minute stale window and so has crashed.

## CRM stages

Stages move forward freely (skipping is allowed), one step back is allowed to fix a mistake, any lead can be marked `DEAD`, and a dead lead can only be reopened to `NEW` or `QUALIFIED` (`src/lib/crm.ts`). Every stage change is stored in `StageChange`.

**Review & send.** Each campaign has a review page (`/campaigns/<id>/review`, `src/lib/review.ts`) with one card per lead, under *Ready to send* (an unsent draft), *Needs a draft* (a verified gap and a way to reach it, still NEW or QUALIFIED) and *Sent*. Opening a card shows its message to read and edit, then the channel’s own action: open the email app with subject and text filled in, open WhatsApp with the text ready (international numbers only, so no country code is guessed), open the Facebook or Instagram page, or call. Nothing is sent by the app. **Mark as sent** saves any edits first, so the record is what went out, and a sent draft can no longer be edited.

**Sending email from the app.** With `SMTP_URL`, `MAIL_FROM` and `MAIL_OPT_OUT` set (see `.env.example`), an email card has **Send email** (`POST /api/outreach/<id>/send`, `src/lib/mail.ts`). Before anything goes out it checks the draft is an unsent email, the lead has a usable address, the address and its domain are not on the do-not-contact list (`/api/do-not-contact`; a card can add its address), and fewer than `MAIL_DAILY_LIMIT` (default 20) emails went out in the last 24 hours. The opt-out line is added to every email, along with a `List-Unsubscribe` header, and nothing is sent without it. A send that the mail server refuses leaves the draft unsent; one that succeeds is recorded as sent by the app, with its Message-ID. `MAIL_DRY_RUN=1` builds the email exactly and shows it without sending. **There is no login yet:** anyone who can reach the app could send from the mailbox, so run it with `npm run start:local`, which listens on this computer only.

**Pipeline.** The home page shows how many leads have reached each stage across all campaigns, and what share of contacted leads replied and of replies converted (`GET /api/pipeline`, or `?campaignId=` for one). A lead counts at the furthest stage its history shows, so one that replied and was later marked dead still counts as a reply, and skipping a stage counts as passing it.

**Follow-ups and sends.** Each lead can have a follow-up day. The home page lists every lead due today or earlier across campaigns (dead leads excluded), and the campaign table shows each date and can sort by it. **Mark as sent** on a draft records when it went out; a lead still NEW or QUALIFIED moves to CONTACTED, with its stage-history row, and gets a follow-up three days later unless one is already planned. A follow-up is stored as a calendar day (UTC midnight), so no timezone can move it, and "due" is decided by the browser's own today.

The stage buttons on a lead apply those same rules, so a move the API would reject is shown as unavailable rather than failing on click. A lead's full `StageChange` log is listed under **Stage history**.

## What the UI shows

Everything a scan concluded is visible, including how sure it was:

- **Scan history** per campaign — the last five runs with status, duration, how
  many records were found, created, refreshed and skipped, and the error for a
  failed run. A failed scan still lists the leads from the last good one.
- **Site status** per lead (`None listed`, `Needs work`, `Inconclusive`,
  `Looks fine`). `Inconclusive` means a check failed, not that the site is bad,
  and `None listed` means the listing has no website — the business may still
  have one.
- **Certainty on every gap**, in the campaign table as well as the lead page.
  An `UNCERTAIN` signal is always marked `(unverified)`, so a failed request is
  never presented as a proven gap.
- **Leads that stopped appearing.** Scans never delete, so a lead whose
  `lastSeenAt` predates the latest successful scan is marked *Not in last scan*
  instead of silently vanishing.
- **Earlier outreach drafts**, collapsed under the current one, with a copy
  button that yields the subject and body as pasteable text.
- **Why each score is what it is.** The lead page lists every term: each gap's points (an unverified one at half), each viability credit, any ghost penalty and the cap. It is computed by the same function as the score, and if the stored score came from weights that have since changed, it says so and points to **Recalculate scores**.
- **A map** of the filtered leads (**Table / Map** on a campaign): one dot per lead with coordinates, coloured by site status and sized by score, with a popup linking to the lead. Leaflet loads only when the map is opened; tiles come from OpenStreetMap with its required attribution, and lead names are escaped before reaching the popup.
- **Contact details** per lead: which channels exist in the campaign table, and
  the phone, email and profile links themselves on the lead page.
- **Filter and sort** the lead table by CRM stage, site status, whether a lead
  can be contacted at all, score or name. This is client-side: every lead is
  already on the page.
- **CSV export** per campaign (`GET /api/campaigns/<id>/export`). Verified and
  unverified gaps are separate columns, so the certainty split survives into a
  spreadsheet. Fields are RFC 4180 quoted and a leading `=`, `+`, `-` or `@` is
  neutralized, because the rows are third-party data and the destination is
  Excel (`src/lib/csv.ts`). The guard is a leading apostrophe, and Excel shows
  it when opening a CSV, so a phone number reads `'+355 69 123 4567`. Without
  the guard, a compact number like `+355691234567` opens as `3.56E+11`. The
  export always covers the whole campaign, not the filtered view.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY (needed for outreach drafting only)
npx prisma migrate deploy
npm run dev
```

Checks: `npm run typecheck`, `npm run lint`, `npm test` (Vitest; builds a throwaway SQLite database from the real migrations, so it never touches your `dev.db`), and `npm run build`. `npm install` runs `prisma generate` for you.

The same four checks run in CI on every push and pull request (`.github/workflows/ci.yml`, Node 22).

Open [http://localhost:3000](http://localhost:3000). Create a campaign with a
narrow region + niche, run the pipeline, then open a lead to see its score,
gap signals, generate an outreach draft, and move it through the CRM stages.

The dev database is SQLite (`dev.db` in the project root, gitignored). To move to Postgres
for production, change the `datasource` provider in `prisma/schema.prisma`
and swap the driver adapter in `src/lib/prisma.ts` for `@prisma/adapter-pg`
(or your Postgres adapter of choice) — the rest of the app is unaffected.

## Tech stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- Prisma 7 + SQLite (via `@prisma/adapter-better-sqlite3`)
- Playwright (Google Maps scraper source only)
- Anthropic SDK (`claude-opus-4-8`) for outreach drafting, using structured
  outputs so every draft is `{ subject, open_line, body }`

## Project layout

```
src/lib/sources/     business-source adapters (OSM, Google Maps scraper)
src/lib/safeFetch.ts SSRF-guarded page fetcher (address checks, redirects, deadline, size cap)
src/lib/detect.ts    gap-signal detection with verified/uncertain certainty
src/lib/score.ts     opportunity scoring (gap severity × business viability)
src/lib/scan.ts      campaign scan: claim, discover, analyze, apply in one transaction
src/lib/dedupe.ts    stable lead identity across reruns
src/lib/crm.ts       allowed CRM stage transitions
src/lib/leads.ts     stage/notes updates with history
src/lib/outreach.ts  Claude-drafted outreach messages (output validated with Zod)
src/lib/display.ts   shared labels/formatting for scan-derived state
src/lib/csv.ts       CSV serialization (RFC 4180 quoting, spreadsheet formula guard)
src/app/api/         REST endpoints the UI calls
src/app/             campaign dashboard, campaign detail, lead detail/CRM
prisma/schema.prisma data model: Campaign, ScanRun, Business, GapSignal, Outreach, StageChange
tests/               Vitest suites (scoring, detection, fetcher, scans, CRM, migration, display, csv)
```
