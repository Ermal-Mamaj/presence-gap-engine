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
5. **Reach out** — generates a specific, non-templated outreach draft per lead from its actual detected signals, via the Claude API (`src/lib/outreach.ts`).
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
- **Google Maps scraper** (`GOOGLE_MAPS_SCRAPER`, experimental) — uses
  Playwright to scrape Google Maps search results and each listing's detail
  pane for name, address, phone, website, rating, and review count.
  **This violates Google's Terms of Service.** It also depends on Google's
  unversioned DOM, so it can break at any time, and Google may rate-limit or
  block the IP running it. It's included because it gives much richer data
  (most OSM entries lack a `website` tag even when the business has one),
  but keep volumes small and infrequent if you use it. The code is capped at
  40 listings per run by design.

Adding a new source means implementing `BusinessSource` in
`src/lib/sources/` and registering it in `src/lib/sources/index.ts` — nothing
else in the pipeline needs to change.

## How scans behave

A campaign's scan (`src/lib/scan.ts`) is built so that running it again can never make things worse:

- **Nothing is deleted.** Discovery and website checks run in memory first. Results are then applied in one database transaction that only creates or updates leads, so a failed or partial scan leaves earlier leads untouched. Leads, their CRM stage, notes, outreach drafts and stage history are never removed by a scan.
- **Reruns update in place.** A lead's identity is its source id (or, without one, its normalized name + address), enforced by a unique key per campaign (`src/lib/dedupe.ts`). A rerun refreshes the data and replaces the lead's gap signals; it does not add duplicates. A value the source stops reporting is kept rather than erased.
- **Each scan is recorded** as a `ScanRun` (status, found/created/updated/skipped counts, error). `Campaign.status` reflects the latest scan; a `FAILED` campaign still shows the leads from its last good scan.
- **One scan at a time per campaign.** The campaign is claimed with a single atomic update; a second request gets HTTP 409. A scan that crashed is considered abandoned after 15 minutes and can be rerun.
- **Bad records are skipped, not fatal.** A record without a name is dropped; an impossible field (a rating of 47) becomes "unknown". If a source returns records but none are usable, the scan fails instead of silently saving nothing. An empty result is a valid result.

## Website checks and certainty

Business websites come from data anyone can edit, so `src/lib/safeFetch.ts` treats every URL as hostile: http(s) only, no credentials, only ports 80/443/8080/8443, every resolved IP checked at connect time (loopback, private, link-local, carrier-grade NAT, multicast, reserved and the IPv6/NAT64/6to4 equivalents are refused), redirects followed manually and re-validated per hop (max 5), one total deadline of 8 seconds covering the body, a 1 MiB size cap that also applies after decompression, and at most 8 requests in flight process-wide. Pages are read as text and never executed.

A failed request is **not** proof of a gap. Network errors, timeouts, TLS failures and HTTP 401/403/429/5xx are recorded as `UNCERTAIN` (and retried once if transient); only a 404/410, a missing viewport tag, plain HTTP and a stale footer on a fully-read page are `VERIFIED`. A missing `website` field is recorded as "No website found", meaning *the listing has none*. OpenStreetMap often omits websites that exist, so treat that as a lead to check, not a fact. Outreach drafts only cite `VERIFIED` signals.

## Scoring

`score = gap points × viability multiplier`, clamped to 0–100 (`src/lib/score.ts`; `explainScore` returns every term).

- **Gap points** are the sum of signal severities (no website 40, unreachable 35, HTTP error 30, TLS problem 25, no HTTPS 15, no mobile viewport 15, stale site 10, thin listing 10). An `UNCERTAIN` signal counts for half: one failed request makes a lead worth a look, but is not proof. This 0.5 is a judgement call, not a measured value.
- **Viability multiplier** is 1 plus up to 0.6 for review volume (log scale, full credit at 200 reviews), up to 0.3 for rating, and 0.1 for a phone number. Weights are unchanged from the original model.
- **Unknown is not zero.** A review count or rating the source never reported earns no credit but is not evidence of an empty listing. A *reported* 0 reviews / unrated listing with no phone is treated as a likely ghost and halved. Likewise "little to no reviews" is only flagged when the source actually reports review data (OpenStreetMap never does).
- Invalid inputs (a rating outside 0–5, negative or non-finite counts or severities) are ignored, so the score is always finite and within range.

## CRM stages

Stages move forward freely (skipping is allowed), one step back is allowed to fix a mistake, any lead can be marked `DEAD`, and a dead lead can only be reopened to `NEW` or `QUALIFIED` (`src/lib/crm.ts`). Every stage change is stored in `StageChange`.

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
- **Earlier outreach drafts**, collapsed under the current one.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY (needed for outreach drafting only)
npx prisma migrate deploy
npm run dev
```

Checks: `npm run typecheck`, `npm run lint`, `npm test` (Vitest; builds a throwaway SQLite database from the real migrations, so it never touches `prisma/dev.db`), and `npm run build`. `npm install` runs `prisma generate` for you.

The same four checks run in CI on every push and pull request (`.github/workflows/ci.yml`, Node 22).

Open [http://localhost:3000](http://localhost:3000). Create a campaign with a
narrow region + niche, run the pipeline, then open a lead to see its score,
gap signals, generate an outreach draft, and move it through the CRM stages.

The dev database is SQLite (`prisma/dev.db`, gitignored). To move to Postgres
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
src/app/api/         REST endpoints the UI calls
src/app/             campaign dashboard, campaign detail, lead detail/CRM
prisma/schema.prisma data model: Campaign, ScanRun, Business, GapSignal, Outreach, StageChange
tests/               Vitest suites (scoring, detection, fetcher, scans, CRM, migration, display)
```
