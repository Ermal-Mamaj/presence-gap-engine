/**
 * The API routes, called as Next calls them, against a real migrated
 * database. The lib functions behind them are tested on their own; these
 * check what a client actually sees: status codes, error messages, headers,
 * and that each route reaches the right lib call.
 */
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

// The app's own client reads DATABASE_URL when src/lib/prisma.ts loads, so
// point it at this file's database before importing any route.
process.env.DATABASE_URL = `file:${db.file}`;

// A scan runs after the response through next/server's `after`, which needs
// a live request scope; here it simply runs the callback. The source is a
// stub, so no test reaches the network.
const pendingAfter: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => Promise<unknown>) => void pendingAfter.push(fn()) };
});
vi.mock("@/lib/sources", () => ({
  getSource: () => ({ id: "OSM", search: async () => [{ name: "Klinika", sourceRef: "osm:node/1", phone: "+355 1" }] }),
}));

const campaigns = await import("@/app/api/campaigns/route");
const campaign = await import("@/app/api/campaigns/[id]/route");
const run = await import("@/app/api/campaigns/[id]/run/route");
const exportCsv = await import("@/app/api/campaigns/[id]/export/route");
const rescore = await import("@/app/api/campaigns/[id]/rescore/route");
const bulkDrafts = await import("@/app/api/campaigns/[id]/drafts/route");
const leadStatus = await import("@/app/api/leads/[id]/status/route");
const leadDraft = await import("@/app/api/leads/[id]/draft/route");
const lead = await import("@/app/api/leads/[id]/route");
const sent = await import("@/app/api/outreach/[id]/sent/route");
const followups = await import("@/app/api/followups/route");
const pipeline = await import("@/app/api/pipeline/route");

// The routes opened the app's own client on this database; close it before the
// file is deleted (after-hooks run in reverse, so this runs before cleanup).
const { prisma: appPrisma } = await import("@/lib/prisma");
afterAll(() => appPrisma.$disconnect());

const request = (method: string, body?: unknown, url = "http://test.local/api") =>
  new NextRequest(url, {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    headers: { "Content-Type": "application/json" },
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function newCampaign(data: Record<string, unknown> = {}) {
  const res = await campaigns.POST(request("POST", { name: "Dentists", region: "Tirana", niche: "dentist", source: "OSM", ...data }));
  return (await res.json()) as { id: string; language: string };
}

async function newLead(campaignId: string, data: Record<string, unknown> = {}) {
  return prisma.business.create({
    data: { campaignId, name: "Klinika", dedupeKey: `k${Math.random()}`, phone: "+355 1", ...data },
  });
}

describe("POST /api/campaigns", () => {
  it("creates a campaign, English by default", async () => {
    const res = await campaigns.POST(request("POST", { name: "D", region: "Tirana", niche: "dentist", source: "OSM" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "D", language: "en", status: "DRAFT" });
  });

  it.each([
    ["not JSON", "{oops", "Request body must be JSON"],
    ["an unknown source", { name: "D", region: "R", niche: "n", source: "YELP" }, "source must be OSM or GOOGLE_MAPS_SCRAPER"],
    ["an unknown language", { name: "D", region: "R", niche: "n", source: "OSM", language: "xx" }, "language must be one of"],
    ["a missing name", { region: "R", niche: "n", source: "OSM" }, "name, region, and niche are required"],
  ])("refuses %s with 400", async (_name, body, message) => {
    const res = await campaigns.POST(request("POST", body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
  });
});

describe("/api/campaigns/[id]", () => {
  it("answers 404 for a campaign that does not exist", async () => {
    expect((await campaign.GET(request("GET"), params("nope"))).status).toBe(404);
    expect((await campaign.PATCH(request("PATCH", { name: "x" }), params("nope"))).status).toBe(404);
    expect((await campaign.DELETE(request("DELETE"), params("nope"))).status).toBe(404);
  });

  it("renames, and refuses an empty update", async () => {
    const { id } = await newCampaign();
    const res = await campaign.PATCH(request("PATCH", { name: "Tirana dentists", language: "sq" }), params(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Tirana dentists", language: "sq" });
    expect((await campaign.PATCH(request("PATCH", {}), params(id))).status).toBe(400);
  });

  it("refuses to delete during a scan, then deletes with 204", async () => {
    const { id } = await newCampaign();
    await prisma.campaign.update({ where: { id }, data: { status: "RUNNING" } });
    const refused = await campaign.DELETE(request("DELETE"), params(id));
    expect(refused.status).toBe(409);
    await prisma.campaign.update({ where: { id }, data: { status: "DONE" } });
    expect((await campaign.DELETE(request("DELETE"), params(id))).status).toBe(204);
  });
});

describe("POST /api/campaigns/[id]/run", () => {
  it("answers 404 for a missing campaign and 409 while another scan holds it", async () => {
    expect((await run.POST(request("POST"), params("nope"))).status).toBe(404);
    const { id } = await newCampaign();
    await prisma.campaign.update({ where: { id }, data: { status: "RUNNING" } });
    expect((await run.POST(request("POST"), params(id))).status).toBe(409);
  });

  it("answers 202 straight away, then the scan saves its leads", async () => {
    const { id } = await newCampaign();
    const res = await run.POST(request("POST"), params(id));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "RUNNING" });
    await Promise.all(pendingAfter);
    const saved = await prisma.campaign.findUniqueOrThrow({ where: { id }, include: { businesses: true } });
    expect(saved.status).toBe("DONE");
    expect(saved.businesses.map((b) => b.name)).toEqual(["Klinika"]);
  });
});

describe("GET /api/campaigns/[id]/export", () => {
  it("downloads a CSV named after the campaign, with the formula guard applied", async () => {
    const { id } = await newCampaign({ name: "Tirana dentists" });
    await newLead(id, { name: "=HYPERLINK(1)" });
    const res = await exportCsv.GET(request("GET"), params(id));
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="tirana-dentists-leads.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("'=HYPERLINK(1)");
  });

  it("answers 404 for a missing campaign", async () => {
    expect((await exportCsv.GET(request("GET"), params("nope"))).status).toBe(404);
  });
});

describe("campaign rescore and bulk drafts", () => {
  it("rescore answers 404, or the counts", async () => {
    expect((await rescore.POST(request("POST"), params("nope"))).status).toBe(404);
    const { id } = await newCampaign();
    await newLead(id, { score: 0, signals: { create: [{ key: "no_website", label: "No website found", severity: 40 }] } });
    const res = await rescore.POST(request("POST"), params(id));
    expect(await res.json()).toEqual({ rescored: 1, changed: 1 });
  });

  it("bulk drafts refuse a bad limit and a missing campaign", async () => {
    const { id } = await newCampaign();
    expect((await bulkDrafts.POST(request("POST", { limit: 0 }), params(id))).status).toBe(400);
    expect((await bulkDrafts.POST(request("POST", { limit: 21 }), params(id))).status).toBe(400);
    expect((await bulkDrafts.POST(request("POST", {}), params("nope"))).status).toBe(404);
  });

  it("bulk drafts report nothing to do without calling the model", async () => {
    const { id } = await newCampaign();
    const res = await bulkDrafts.POST(request("POST", {}), params(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ selected: 0, drafted: 0, failed: [] });
  });
});

describe("leads", () => {
  it("GET answers 404 for a missing lead", async () => {
    expect((await lead.GET(request("GET"), params("nope"))).status).toBe(404);
  });

  it("PATCH status: moves a stage, refuses a bad move with 409 and a bad date with 400", async () => {
    const { id: campaignId } = await newCampaign();
    const { id } = await newLead(campaignId, { crmStage: "CONTACTED" });
    expect((await leadStatus.PATCH(request("PATCH", { crmStage: "NEW" }), params(id))).status).toBe(409);
    expect((await leadStatus.PATCH(request("PATCH", { followUpAt: "soon" }), params(id))).status).toBe(400);
    const ok = await leadStatus.PATCH(request("PATCH", { crmStage: "REPLIED", followUpAt: "2026-10-17" }), params(id));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ crmStage: "REPLIED", followUpAt: "2026-10-17T00:00:00.000Z" });
    expect((await leadStatus.PATCH(request("PATCH", { notes: "x" }), params("nope"))).status).toBe(404);
  });

  it("POST draft: 400 for a bad channel, 404 for a missing lead, 422 with nothing verified to say", async () => {
    const { id: campaignId } = await newCampaign();
    const { id } = await newLead(campaignId);
    expect((await leadDraft.POST(request("POST", { channel: "fax" }), params(id))).status).toBe(400);
    expect((await leadDraft.POST(request("POST", {}), params("nope"))).status).toBe(404);
    // No verified gap, so it refuses before any call to the model.
    const res = await leadDraft.POST(request("POST", {}), params(id));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("no verified gap");
  });
});

describe("outreach, follow-ups and pipeline", () => {
  it("marking a draft sent answers 404, or moves the lead along", async () => {
    expect((await sent.POST(request("POST"), params("nope"))).status).toBe(404);
    const { id: campaignId } = await newCampaign();
    const { id } = await newLead(campaignId, { outreach: { create: [{ subject: "s", openLine: "o", body: "b" }] } });
    const draft = await prisma.outreach.findFirstOrThrow({ where: { businessId: id } });
    const res = await sent.POST(request("POST"), params(draft.id));
    expect(res.status).toBe(200);
    expect((await res.json()).business.crmStage).toBe("CONTACTED");
  });

  it("follow-ups need a day, and list what is due", async () => {
    expect((await followups.GET(request("GET", undefined, "http://test.local/api/followups?through=tomorrow"))).status).toBe(400);
    const { id: campaignId } = await newCampaign();
    await newLead(campaignId, { name: "Due", followUpAt: new Date("2026-10-01T00:00:00.000Z") });
    const res = await followups.GET(request("GET", undefined, "http://test.local/api/followups?through=2026-10-14"));
    expect((await res.json()).map((b: { name: string }) => b.name)).toContain("Due");
  });

  it("pipeline answers with a summary", async () => {
    const res = await pipeline.GET(request("GET", undefined, "http://test.local/api/pipeline"));
    expect(await res.json()).toMatchObject({ total: expect.any(Number), reached: expect.any(Array) });
  });
});
