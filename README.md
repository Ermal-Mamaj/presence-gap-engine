# Presence Gap Engine

Find businesses with a visibly weak or missing web presence, prove you noticed
something specific and real about them, offer to fix it, deliver the work,
then keep them around.

This app covers stages 1–6 of that pipeline as a working tool:

1. **Target box** — a campaign is one region + one niche (e.g. "dentists in Tirana").
2. **Find** — pulls a raw business list from a source adapter (`src/lib/sources`).
3. **Detect the gap** — checks each business for publicly observable signals: no website, unreachable site, no HTTPS, no mobile viewport tag, stale copyright year, thin/no reviews (`src/lib/detect.ts`).
4. **Qualify and rank** — combines gap severity with signs of a viable business (reviews, rating, phone) into a score, and penalizes likely-ghost listings (`src/lib/score.ts`).
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

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY (needed for outreach drafting only)
npx prisma migrate deploy
npm run dev
```

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
src/lib/detect.ts    gap-signal detection (no site, HTTPS, mobile, staleness, thin listing)
src/lib/score.ts     opportunity scoring (gap severity × business viability)
src/lib/outreach.ts  Claude-drafted outreach messages
src/app/api/         REST endpoints the UI calls
src/app/             campaign dashboard, campaign detail, lead detail/CRM
prisma/schema.prisma data model: Campaign, Business, GapSignal, Outreach
```
