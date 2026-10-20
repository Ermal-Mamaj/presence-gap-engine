/**
 * The API routes, called as Next calls them, against a real migrated
 * database. The lib functions behind them are tested on their own; these
 * check what a client actually sees: status codes, error messages, headers,
 * and that each route reaches the right lib call.
 */
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;

// The app's own client reads DATABASE_URL when src/lib/prisma.ts loads, so
// point it at this file's database before importing any route. Forward
// slashes, as globalSetup.ts writes it, so the value is a well-formed URL.
process.env.DATABASE_URL = `file:${db.file.split(path.sep).join("/")}`;

// No test may reach Claude: an invalid key and an unroutable base URL make
// any call that slips past the "nothing verified to say" guards fail at once,
// instead of spending money on a machine that has real credentials.
process.env.ANTHROPIC_API_KEY = "test-key-never-valid";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";

// A scan runs after the response through next/server's `after`, which needs
// a live request scope. Here the callback is queued, not run, so a test can
// check the response came first, then run it with runPendingAfter(). The
// source is a stub, so no test reaches the network.
let pendingAfter: (() => Promise<unknown>)[] = [];
async function runPendingAfter() {
  const queued = pendingAfter;
  pendingAfter = [];
  await Promise.all(queued.map((fn) => fn()));
}
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => Promise<unknown>) => void pendingAfter.push(fn) };
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

const { MAX_BULK_DRAFTS } = await import("@/lib/drafting");

// One teardown, in order: finish any scan still queued, close the app's own
// client (Windows won't delete an open database file), then delete the file.
afterAll(async () => {
  await runPendingAfter().catch(() => undefined);
  const { prisma: appPrisma } = await import("@/lib/prisma");
  await appPrisma.$disconnect();
  await db.cleanup();
});

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

describe("reading campaigns and leads", () => {
  it("lists campaigns with their lead counts", async () => {
    const { id } = await newCampaign({ name: "Listed" });
    await newLead(id);
    const list = await (await campaigns.GET()).json();
    expect(list.find((c: { id: string }) => c.id === id)).toMatchObject({ name: "Listed", _count: { businesses: 1 } });
  });

  it("reads a campaign with its leads, their signals and draft counts, and its scans", async () => {
    const { id } = await newCampaign();
    await newLead(id, { signals: { create: [{ key: "no_website", label: "No website found", severity: 40 }] } });
    const res = await campaign.GET(request("GET"), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scans).toEqual([]);
    expect(body.businesses[0]).toMatchObject({
      signals: [expect.objectContaining({ key: "no_website" })],
      _count: { outreach: 0 },
    });
  });

  it("reads a lead with its signals, drafts, history and campaign", async () => {
    const { id: campaignId } = await newCampaign({ name: "Owner" });
    const { id } = await newLead(campaignId, { outreach: { create: [{ subject: "s", openLine: "o", body: "b" }] } });
    const res = await lead.GET(request("GET"), params(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      signals: [],
      stageChanges: [],
      outreach: [expect.objectContaining({ subject: "s" })],
      campaign: { name: "Owner" },
    });
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
    await newLead(id);
    const refused = await campaign.DELETE(request("DELETE"), params(id));
    expect(refused.status).toBe(409);
    expect(await prisma.business.count({ where: { campaignId: id } })).toBe(1);
    await prisma.campaign.update({ where: { id }, data: { status: "DONE" } });
    expect((await campaign.DELETE(request("DELETE"), params(id))).status).toBe(204);
    expect(await prisma.campaign.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.business.count({ where: { campaignId: id } })).toBe(0);
  });
});

describe("POST /api/campaigns/[id]/run", () => {
  it("answers 404 for a missing campaign and 409 while another scan holds it", async () => {
    expect((await run.POST(request("POST"), params("nope"))).status).toBe(404);
    const { id } = await newCampaign();
    await prisma.campaign.update({ where: { id }, data: { status: "RUNNING" } });
    expect((await run.POST(request("POST"), params(id))).status).toBe(409);
  });

  it("answers 202 before the scan runs, then the scan saves its leads", async () => {
    const { id } = await newCampaign();
    const res = await run.POST(request("POST"), params(id));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "RUNNING" });
    // The response came first: nothing is saved until the deferred work runs.
    const meanwhile = await prisma.campaign.findUniqueOrThrow({ where: { id }, include: { businesses: true } });
    expect(meanwhile).toMatchObject({ status: "RUNNING", businesses: [] });
    await runPendingAfter();
    const saved = await prisma.campaign.findUniqueOrThrow({ where: { id }, include: { businesses: true } });
    expect(saved.status).toBe("DONE");
    expect(saved.businesses.map((b) => b.name)).toEqual(["Klinika"]);
  });
});

describe("POST /api/campaigns/[id]/run with checkOnline", () => {
  it("refuses at once, starting nothing, when no search provider is set up", async () => {
    const { id } = await newCampaign();
    const res = await run.POST(request("POST", { checkOnline: true }), params(id));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("GROQ_API_KEY");
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status).not.toBe("RUNNING");
  });

  it("checks the new leads online once the scan has succeeded", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-test");
    const searches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        searches.push(JSON.parse(String(init.body)).messages[0].content);
        return Response.json({ choices: [{ message: { content: "NONE" } }] });
      })
    );
    try {
      const { id } = await newCampaign();
      expect((await run.POST(request("POST", { checkOnline: true }), params(id))).status).toBe(202);
      await runPendingAfter();
      const saved = await prisma.business.findFirstOrThrow({ where: { campaignId: id } });
      expect(saved).toMatchObject({ name: "Klinika", onlineCheck: "none" });
      expect(searches).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("is a plain scan without it", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { id } = await newCampaign();
      await run.POST(request("POST", {}), params(id));
      await runPendingAfter();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await prisma.business.findFirstOrThrow({ where: { campaignId: id } })).onlineCheck).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe("GET /api/campaigns/[id]/export", () => {
  it("downloads a CSV named after the campaign, with the formula guard applied", async () => {
    const { id } = await newCampaign({ name: "Tirana dentists" });
    await newLead(id, { name: "=HYPERLINK(1)" });
    const res = await exportCsv.GET(request("GET"), params(id));
    expect(res.status).toBe(200);
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
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rescored: 1, changed: 1 });
  });

  it("bulk drafts refuse a bad limit and a missing campaign", async () => {
    const { id } = await newCampaign();
    expect((await bulkDrafts.POST(request("POST", { limit: 0 }), params(id))).status).toBe(400);
    expect((await bulkDrafts.POST(request("POST", { limit: MAX_BULK_DRAFTS + 1 }), params(id))).status).toBe(400);
    expect((await bulkDrafts.POST(request("POST", { limit: MAX_BULK_DRAFTS }), params(id))).status).toBe(200);
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

  it("POST draft with followUp: 409 until something has been sent, then 422 without a follow-up template", async () => {
    const { id: campaignId } = await newCampaign();
    const { id } = await newLead(campaignId);
    const refused = await leadDraft.POST(request("POST", { followUp: true }), params(id));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("Nothing has been sent");
    await prisma.outreach.create({ data: { businessId: id, subject: "s", openLine: "o", body: "b", sentAt: new Date() } });
    const missing = await leadDraft.POST(request("POST", { followUp: true, channel: "email" }), params(id));
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toContain("follow-up template");
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

  it("pipeline counts one campaign when asked, and all of them otherwise", async () => {
    const { id } = await newCampaign();
    await newLead(id, { crmStage: "CONTACTED" });
    await newLead(id);
    const url = `http://test.local/api/pipeline?campaignId=${id}`;
    const one = await (await pipeline.GET(request("GET", undefined, url))).json();
    expect(one).toMatchObject({ total: 2, dead: 0 });
    expect(one.reached.find((r: { stage: string }) => r.stage === "CONTACTED").count).toBe(1);
    const all = await (await pipeline.GET(request("GET", undefined, "http://test.local/api/pipeline"))).json();
    expect(all.total).toBeGreaterThan(2);
  });
});

describe("templates API", () => {
  it("creates, lists, edits and deletes a template, refusing a bad one with its reason", async () => {
    const templates = await import("@/app/api/templates/route");
    const one = await import("@/app/api/templates/[id]/route");
    const input = { language: "sq", channel: "email", gapKey: "no_website", subject: "Për {{name}}", body: "Përshëndetje {{name}}" };

    const bad = await templates.POST(request("POST", { ...input, body: "Hi {{owner}}" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("Unknown placeholder");

    const created = await templates.POST(request("POST", input));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const listed = await (await templates.GET()).json();
    expect(listed.find((t: { id: string }) => t.id === id)).toMatchObject({ _count: { outreach: 0 } });

    const edited = await one.PATCH(request("PATCH", { ...input, body: "Tjetër {{name}}" }), params(id));
    expect(edited.status).toBe(200);
    expect((await one.DELETE(request("DELETE"), params(id))).status).toBe(204);
    expect((await one.DELETE(request("DELETE"), params(id))).status).toBe(404);
  });

  it("drafts a lead from a template, and says which one is missing when none fits", async () => {
    const templates = await import("@/app/api/templates/route");
    const { id: campaignId } = await newCampaign({ language: "sq" });
    const { id } = await newLead(campaignId, { signals: { create: [{ key: "no_website", label: "No website found", severity: 40 }] } });

    const missing = await leadDraft.POST(request("POST", { channel: "phone" }), params(id));
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toContain("call script template");

    await templates.POST(request("POST", { language: "sq", channel: "phone", gapKey: "no_website", body: "Mirëdita, flas për {{name}}" }));
    const made = await leadDraft.POST(request("POST", { channel: "phone" }), params(id));
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ channel: "phone", body: "Mirëdita, flas për Klinika", templateId: expect.any(String) });
  });
});

describe("review queue and draft edits", () => {
  it("lists a campaign's queue, and saves edits to an unsent draft but not a sent one", async () => {
    const review = await import("@/app/api/campaigns/[id]/review/route");
    const draftRoute = await import("@/app/api/outreach/[id]/route");
    expect((await review.GET(request("GET"), params("nope"))).status).toBe(404);

    const { id: campaignId } = await newCampaign();
    const { id } = await newLead(campaignId, {
      signals: { create: [{ key: "no_website", label: "No website found", severity: 40 }] },
      outreach: { create: [{ subject: "s", openLine: "o", body: "b" }] },
    });
    const queue = await (await review.GET(request("GET"), params(campaignId))).json();
    expect(queue.ready.map((c: { leadId: string }) => c.leadId)).toEqual([id]);

    const draftId = queue.ready[0].draft.id;
    expect((await draftRoute.PATCH(request("PATCH", { body: "" }), params(draftId))).status).toBe(400);
    const saved = await draftRoute.PATCH(request("PATCH", { subject: "Better", body: "Edited" }), params(draftId));
    expect(saved.status).toBe(200);
    await sent.POST(request("POST", {}), params(draftId));
    expect((await draftRoute.PATCH(request("PATCH", { body: "Late edit" }), params(draftId))).status).toBe(409);
  });
});

describe("online check route", () => {
  it("reports no provider, refuses to start without one, and checks its input", async () => {
    const check = await import("@/app/api/campaigns/[id]/online-check/route");
    const { id } = await newCampaign();
    expect(await (await check.GET(request("GET"), params(id))).json()).toEqual({ provider: null, progress: null });
    expect((await check.POST(request("POST", { limit: 0 }), params(id))).status).toBe(400);
    expect((await check.POST(request("POST", {}), params("nope"))).status).toBe(404);
    const refused = await check.POST(request("POST", {}), params(id));
    expect(refused.status).toBe(503);
    expect((await refused.json()).error).toContain("GROQ_API_KEY, OPENROUTER_API_KEY or TAVILY_API_KEY");
  });
});
