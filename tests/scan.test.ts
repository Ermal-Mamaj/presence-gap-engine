import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectableBusiness, DetectedSignal, PresenceAnalysis } from "@/lib/detect";
import {
  CampaignNotFoundError,
  claimCampaignScan,
  DiscoveryError,
  executeCampaignScan,
  runCampaignScan,
  ScanConflictError,
  type ScanDeps,
} from "@/lib/scan";
import type { BusinessSource, RawBusiness } from "@/lib/sources/types";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

const NO_WEBSITE: DetectedSignal = {
  key: "no_website",
  label: "No website found",
  severity: 40,
  certainty: "VERIFIED",
};

// Deterministic stand-in for the network: no website is a gap, a website is fine.
const fakeAnalyze = async (business: DetectableBusiness): Promise<PresenceAnalysis> =>
  business.website
    ? { signals: [], websiteStatus: "GOOD" }
    : { signals: [NO_WEBSITE], websiteStatus: "NONE_FOUND" };

const biz = (n: number, extra: Partial<RawBusiness> = {}): RawBusiness => ({
  name: `Business ${n}`,
  address: `${n} Main St`,
  sourceRef: `osm:node/${n}`,
  ...extra,
});

function sourceOf(search: BusinessSource["search"]): ScanDeps["getSource"] {
  return () => ({ id: "OSM", search });
}
const returning = (list: unknown[]) => sourceOf(async () => list as RawBusiness[]);
const failing = (message = "Overpass API error: 504") =>
  sourceOf(async () => {
    throw new Error(message);
  });

const scan = (campaignId: string, getSource: ScanDeps["getSource"], extra: Partial<ScanDeps> = {}) =>
  runCampaignScan(prisma, campaignId, { getSource, analyze: fakeAnalyze, ...extra });

async function newCampaign() {
  return prisma.campaign.create({ data: { name: "Dentists", region: "Prizren", niche: "dentist" } });
}
const leads = (campaignId: string) =>
  prisma.business.findMany({ where: { campaignId }, include: { signals: true }, orderBy: { name: "asc" } });

let campaignId: string;
beforeEach(async () => {
  campaignId = (await newCampaign()).id;
});

describe("a successful scan", () => {
  it("saves leads with their signals, status, score and a ScanRun record", async () => {
    const outcome = await scan(campaignId, returning([biz(1, { phone: "123" }), biz(2, { website: "example.com" }), biz(3)]));

    expect(outcome).toMatchObject({ found: 3, created: 3, updated: 0, skipped: 0 });

    const saved = await leads(campaignId);
    expect(saved).toHaveLength(3);
    const one = saved.find((b) => b.name === "Business 1")!;
    expect(one).toMatchObject({
      dedupeKey: "ref:osm:node/1",
      websiteStatus: "NONE_FOUND",
      crmStage: "NEW",
      phone: "123",
    });
    expect(one.score).toBe(44); // 40 * (1 + 0.1 phone credit)
    expect(one.signals.map((s) => s.key)).toEqual(["no_website"]);
    expect(one.signals[0].certainty).toBe("VERIFIED");

    const two = saved.find((b) => b.name === "Business 2")!;
    expect(two).toMatchObject({ websiteStatus: "GOOD", score: 0 });
    expect(two.signals).toEqual([]);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign).toMatchObject({ status: "DONE", errorMessage: null });

    const runs = await prisma.scanRun.findMany({ where: { campaignId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "SUCCEEDED", found: 3, created: 3, updated: 0, skipped: 0 });
    expect(runs[0].finishedAt).not.toBeNull();
  });

  it("passes the campaign's region and niche to the source", async () => {
    const search = vi.fn(async () => [biz(1)]);
    await scan(campaignId, sourceOf(search));
    expect(search).toHaveBeenCalledWith({ region: "Prizren", niche: "dentist" });
  });

  it("asks for the source named by the campaign", async () => {
    const getSource = vi.fn(returning([biz(1)]));
    await scan(campaignId, getSource);
    expect(getSource).toHaveBeenCalledWith("OSM");
  });

  it("limits how many websites are analysed at once", async () => {
    let active = 0;
    let max = 0;
    const analyze = async (b: DetectableBusiness) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return fakeAnalyze(b);
    };
    await scan(campaignId, returning(Array.from({ length: 20 }, (_, i) => biz(i + 1))), { analyze, concurrency: 3 });
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(3);
  });
});

describe("empty and partial discovery", () => {
  it("treats an empty result as a successful scan that found nothing", async () => {
    const outcome = await scan(campaignId, returning([]));
    expect(outcome).toMatchObject({ found: 0, created: 0, updated: 0 });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("DONE");
  });

  it("does not delete existing leads when a rescan comes back empty", async () => {
    await scan(campaignId, returning([biz(1), biz(2)]));
    await scan(campaignId, returning([]));
    expect(await leads(campaignId)).toHaveLength(2);
  });

  it("saves the usable records and counts the rest as skipped", async () => {
    const outcome = await scan(
      campaignId,
      returning([biz(1), { name: "" }, null, 42, biz(2, { rating: 99 }), { address: "no name" }])
    );
    expect(outcome).toMatchObject({ found: 2, created: 2, skipped: 4 });
    const saved = await leads(campaignId);
    expect(saved.map((b) => b.name)).toEqual(["Business 1", "Business 2"]);
    expect(saved[1].rating).toBeNull(); // an impossible rating becomes unknown, not a rejection
    expect((await prisma.scanRun.findFirstOrThrow({ where: { campaignId } })).skipped).toBe(4);
  });

  it("fails, saving nothing, when every record is unusable", async () => {
    await expect(scan(campaignId, returning([{ name: "" }, null, 7]))).rejects.toBeInstanceOf(DiscoveryError);
    expect(await leads(campaignId)).toHaveLength(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FAILED");
  });

  it("fails when the source does not return a list", async () => {
    await expect(scan(campaignId, sourceOf(async () => ({ elements: [] }) as never))).rejects.toBeInstanceOf(DiscoveryError);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FAILED");
  });
});

describe("a failed scan does not destroy earlier results", () => {
  async function seed() {
    await scan(campaignId, returning([biz(1, { phone: "123" }), biz(2), biz(3)]));
    return leads(campaignId);
  }

  it("keeps every lead, signal and score when discovery fails", async () => {
    const before = await seed();
    await expect(scan(campaignId, failing())).rejects.toBeInstanceOf(DiscoveryError);

    const after = await leads(campaignId);
    expect(after).toEqual(before);
  });

  it("reports the failure on the campaign and the ScanRun, without hiding the earlier success", async () => {
    await seed();
    await expect(scan(campaignId, failing("Overpass API error: 504"))).rejects.toThrow("Overpass API error: 504");

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign).toMatchObject({ status: "FAILED", errorMessage: "Overpass API error: 504" });

    const runs = await prisma.scanRun.findMany({ where: { campaignId }, orderBy: { startedAt: "asc" } });
    expect(runs.map((r) => r.status)).toEqual(["SUCCEEDED", "FAILED"]);
    expect(runs[1].errorMessage).toBe("Overpass API error: 504");
    expect(runs[1].finishedAt).not.toBeNull();
    expect(runs[0]).toMatchObject({ found: 3, created: 3 });
  });

  it("returns to DONE on the next successful scan", async () => {
    await seed();
    await expect(scan(campaignId, failing())).rejects.toThrow();
    await scan(campaignId, returning([biz(1), biz(2), biz(3)]));
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign).toMatchObject({ status: "DONE", errorMessage: null });
  });

  it("keeps earlier leads when website analysis crashes", async () => {
    const before = await seed();
    const analyze = async () => {
      throw new Error("analysis exploded");
    };
    await expect(scan(campaignId, returning([biz(1), biz(4)]), { analyze })).rejects.toThrow("analysis exploded");
    expect(await leads(campaignId)).toEqual(before);
  });

  it("keeps earlier leads and adds none of the new ones when saving fails part-way", async () => {
    const before = await seed();

    // Lead 5 produces a signal Prisma rejects (a required column is missing),
    // after leads 1 and 4 have already been written inside the transaction.
    const analyze = async (b: DetectableBusiness): Promise<PresenceAnalysis> =>
      b.website === "poison.example"
        ? { signals: [{ ...NO_WEBSITE, label: undefined as unknown as string }], websiteStatus: "NEEDS_WORK" }
        : fakeAnalyze(b);
    const source = returning([biz(1, { phone: "999-changed" }), biz(4), biz(5, { website: "poison.example" })]);

    await expect(scan(campaignId, source, { analyze })).rejects.toThrow();

    expect(await leads(campaignId)).toEqual(before); // lead 1 not half-updated, lead 4 not added
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("FAILED");
    const lastRun = await prisma.scanRun.findFirstOrThrow({ where: { campaignId }, orderBy: { startedAt: "desc" } });
    expect(lastRun.status).toBe("FAILED");
  });

  it("fails cleanly for a source the app does not know", async () => {
    const before = await seed();
    const unknown = () => {
      throw new Error('Unknown source "NOPE"');
    };
    await expect(scan(campaignId, unknown)).rejects.toThrow('Unknown source "NOPE"');
    expect(await leads(campaignId)).toEqual(before);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("FAILED");
  });

  it("reports a missing campaign", async () => {
    await expect(scan("does-not-exist", returning([biz(1)]))).rejects.toBeInstanceOf(CampaignNotFoundError);
  });
});

describe("reruns do not create duplicates", () => {
  it("updates leads in place instead of adding them again", async () => {
    await scan(campaignId, returning([biz(1), biz(2)]));
    const firstIds = (await leads(campaignId)).map((b) => b.id);

    const outcome = await scan(campaignId, returning([biz(1), biz(2)]));
    expect(outcome).toMatchObject({ found: 2, created: 0, updated: 2 });

    const after = await leads(campaignId);
    expect(after.map((b) => b.id)).toEqual(firstIds);
  });

  it("recognises a business whose source id is missing by name and address", async () => {
    const noRef = (n: number, name = `Business ${n}`) => ({ name, address: `${n} Main St` });
    await scan(campaignId, returning([noRef(1)]));
    await scan(campaignId, returning([{ name: "BUSINESS 1", address: "1 main st." }]));
    expect(await leads(campaignId)).toHaveLength(1);
  });

  it("collapses duplicates within one scan", async () => {
    const outcome = await scan(campaignId, returning([biz(1), biz(1, { phone: "dup" }), biz(2)]));
    expect(outcome).toMatchObject({ found: 2, created: 2, skipped: 1 });
    expect(await leads(campaignId)).toHaveLength(2);
  });

  it("keeps the same business in two campaigns separate", async () => {
    const other = await newCampaign();
    await scan(campaignId, returning([biz(1)]));
    await scan(other.id, returning([biz(1)]));
    expect(await leads(campaignId)).toHaveLength(1);
    expect(await leads(other.id)).toHaveLength(1);
  });

  it("replaces a lead's signals instead of piling up new ones", async () => {
    await scan(campaignId, returning([biz(1)]));
    await scan(campaignId, returning([biz(1)]));
    await scan(campaignId, returning([biz(1)]));
    const [lead] = await leads(campaignId);
    expect(lead.signals).toHaveLength(1);
  });

  it("reflects what changed at the source: a new website replaces the 'no website' gap", async () => {
    await scan(campaignId, returning([biz(1)]));
    expect((await leads(campaignId))[0]).toMatchObject({ websiteStatus: "NONE_FOUND", score: 40 });

    await scan(campaignId, returning([biz(1, { website: "example.com" })]));
    const [lead] = await leads(campaignId);
    expect(lead).toMatchObject({ websiteStatus: "GOOD", score: 0, website: "example.com" });
    expect(lead.signals).toEqual([]);
  });

  it("never replaces a known value with 'unknown'", async () => {
    await scan(campaignId, returning([biz(1, { phone: "+383 1", rating: 4.5, reviewCount: 12 })]));
    await scan(campaignId, returning([biz(1)])); // thinner data this time
    const [lead] = await leads(campaignId);
    expect(lead).toMatchObject({ phone: "+383 1", rating: 4.5, reviewCount: 12 });
  });

  it("updates lastSeenAt only for leads the scan returned", async () => {
    await scan(campaignId, returning([biz(1), biz(2)]));
    const before = await leads(campaignId);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await scan(campaignId, returning([biz(1)]));
    const after = await leads(campaignId);

    expect(after.find((b) => b.name === "Business 1")!.lastSeenAt.getTime()).toBeGreaterThan(
      before.find((b) => b.name === "Business 1")!.lastSeenAt.getTime()
    );
    expect(after.find((b) => b.name === "Business 2")!.lastSeenAt).toEqual(
      before.find((b) => b.name === "Business 2")!.lastSeenAt
    );
  });
});

describe("contact history survives a refresh", () => {
  it("keeps stage, notes, outreach and stage history for leads that were worked", async () => {
    await scan(campaignId, returning([biz(1), biz(2), biz(3)]));
    const [one, two, three] = await leads(campaignId);

    await prisma.business.update({ where: { id: one.id }, data: { crmStage: "CONTACTED", notes: "called, wants a quote" } });
    await prisma.business.update({ where: { id: two.id }, data: { crmStage: "REPLIED" } });
    await prisma.business.update({ where: { id: three.id }, data: { crmStage: "CONVERTED", notes: "signed" } });
    await prisma.outreach.create({ data: { businessId: one.id, subject: "Hi", openLine: "o", body: "b" } });
    await prisma.outreach.create({ data: { businessId: three.id, subject: "Deal", openLine: "o", body: "b" } });
    await prisma.stageChange.create({ data: { businessId: one.id, fromStage: "NEW", toStage: "CONTACTED" } });

    // The rescan returns lead 1 and 2 changed, and lead 3 not at all.
    await scan(campaignId, returning([biz(1, { phone: "new" }), biz(2, { website: "example.com" })]));

    const after = await leads(campaignId);
    expect(after.map((b) => b.id).sort()).toEqual([one.id, two.id, three.id].sort());
    const byId = (id: string) => after.find((b) => b.id === id)!;
    expect(byId(one.id)).toMatchObject({ crmStage: "CONTACTED", notes: "called, wants a quote", phone: "new" });
    expect(byId(two.id)).toMatchObject({ crmStage: "REPLIED", websiteStatus: "GOOD" });
    expect(byId(three.id)).toMatchObject({ crmStage: "CONVERTED", notes: "signed" });

    expect(await prisma.outreach.count({ where: { businessId: one.id } })).toBe(1);
    expect(await prisma.outreach.count({ where: { businessId: three.id } })).toBe(1);
    expect(await prisma.stageChange.count({ where: { businessId: one.id } })).toBe(1);
  });

  it("keeps worked leads even when the rescan fails", async () => {
    await scan(campaignId, returning([biz(1)]));
    const [lead] = await leads(campaignId);
    await prisma.business.update({ where: { id: lead.id }, data: { crmStage: "CONVERTED" } });
    await prisma.outreach.create({ data: { businessId: lead.id, subject: "Deal", openLine: "o", body: "b" } });

    await expect(scan(campaignId, failing())).rejects.toThrow();

    expect((await leads(campaignId))[0]).toMatchObject({ id: lead.id, crmStage: "CONVERTED" });
    expect(await prisma.outreach.count({ where: { businessId: lead.id } })).toBe(1);
  });
});

describe("concurrent scans", () => {
  function gate() {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    return { open, release };
  }

  it("refuses a second scan while the first is still running", async () => {
    const g = gate();
    const slow = sourceOf(async () => {
      await g.open;
      return [biz(1)];
    });

    const first = scan(campaignId, slow);
    await vi.waitFor(async () => {
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("RUNNING");
    });

    await expect(scan(campaignId, returning([biz(2)]))).rejects.toBeInstanceOf(ScanConflictError);

    g.release();
    await expect(first).resolves.toMatchObject({ found: 1 });

    // The refused request changed nothing: one run, one lead, finished status.
    expect(await prisma.scanRun.count({ where: { campaignId } })).toBe(1);
    expect((await leads(campaignId)).map((b) => b.name)).toEqual(["Business 1"]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("DONE");
  });

  it("lets exactly one of several simultaneous requests run", async () => {
    const g = gate();
    const slow = sourceOf(async () => {
      await g.open;
      return [biz(1), biz(2)];
    });

    const attempts = Array.from({ length: 5 }, () => scan(campaignId, slow));
    const settled = Promise.allSettled(attempts);
    await vi.waitFor(async () => {
      expect(await prisma.scanRun.count({ where: { campaignId } })).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the losers finish being refused
    g.release();

    const results = await settled;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(4);
    expect(rejected.every((r) => r.reason instanceof ScanConflictError)).toBe(true);

    expect(await leads(campaignId)).toHaveLength(2);
    expect(await prisma.scanRun.count({ where: { campaignId } })).toBe(1);
  });

  it("allows scans of different campaigns at the same time", async () => {
    const other = await newCampaign();
    const g = gate();
    const slow = sourceOf(async () => {
      await g.open;
      return [biz(1)];
    });
    const a = scan(campaignId, slow);
    const b = scan(other.id, slow);
    await new Promise((resolve) => setTimeout(resolve, 30));
    g.release();
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  it("allows a new scan once the previous one has finished", async () => {
    await scan(campaignId, returning([biz(1)]));
    await expect(scan(campaignId, returning([biz(1)]))).resolves.toMatchObject({ updated: 1 });
  });

  it("allows a retry right after a failure", async () => {
    await expect(scan(campaignId, failing())).rejects.toThrow();
    await expect(scan(campaignId, returning([biz(1)]))).resolves.toMatchObject({ created: 1 });
  });
});

describe("a scan that crashed", () => {
  async function simulateCrash() {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "RUNNING" } });
    return prisma.scanRun.create({ data: { campaignId } });
  }

  it("still blocks other scans while it could plausibly be running", async () => {
    await simulateCrash();
    await expect(scan(campaignId, returning([biz(1)]))).rejects.toBeInstanceOf(ScanConflictError);
  });

  it("is recovered once it has been silent for longer than the stale threshold", async () => {
    const crashed = await simulateCrash();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const outcome = await scan(campaignId, returning([biz(1)]), { staleAfterMs: 10 });
    expect(outcome.created).toBe(1);

    const old = await prisma.scanRun.findUniqueOrThrow({ where: { id: crashed.id } });
    expect(old).toMatchObject({ status: "FAILED", errorMessage: "Interrupted before it finished" });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("DONE");
  });
});

describe("claiming a scan separately from running it", () => {
  // The route claims inside the request and runs the scan after the response,
  // so these two halves must hold on their own, not only in composition.

  it("refuses a campaign that does not exist", async () => {
    await expect(claimCampaignScan(prisma, "no-such-campaign")).rejects.toBeInstanceOf(CampaignNotFoundError);
  });

  it("returns the scan id and what the scan needs to run", async () => {
    const claim = await claimCampaignScan(prisma, campaignId);
    expect(claim).toMatchObject({ campaignId, source: "OSM", region: "Prizren", niche: "dentist" });
    expect(claim.scanId).toBeTruthy();
  });

  it("marks the campaign RUNNING and opens a RUNNING scan", async () => {
    const claim = await claimCampaignScan(prisma, campaignId);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const run = await prisma.scanRun.findUniqueOrThrow({ where: { id: claim.scanId } });
    expect(campaign.status).toBe("RUNNING");
    expect(run.status).toBe("RUNNING");
    expect(run.finishedAt).toBeNull();
  });

  it("refuses a second claim while the first still holds the campaign", async () => {
    await claimCampaignScan(prisma, campaignId);
    await expect(claimCampaignScan(prisma, campaignId)).rejects.toBeInstanceOf(ScanConflictError);
  });

  it("lets a stale claim be taken over, and fails the run it abandoned", async () => {
    const abandoned = await claimCampaignScan(prisma, campaignId);
    // Far enough past the staleness window that the campaign is reclaimable.
    const later = () => new Date(Date.now() + 60 * 60 * 1000);
    const retaken = await claimCampaignScan(prisma, campaignId, { now: later });

    expect(retaken.scanId).not.toBe(abandoned.scanId);
    const previous = await prisma.scanRun.findUniqueOrThrow({ where: { id: abandoned.scanId } });
    expect(previous.status).toBe("FAILED");
    expect(previous.errorMessage).toMatch(/interrupted/i);
    expect(previous.finishedAt).not.toBeNull();
  });

  it("completes the scan when run against its own claim", async () => {
    const claim = await claimCampaignScan(prisma, campaignId);
    const outcome = await executeCampaignScan(prisma, claim, {
      getSource: returning([biz(1), biz(2, { website: "https://example.com" })]),
      analyze: fakeAnalyze,
    });

    expect(outcome).toMatchObject({ scanId: claim.scanId, found: 2, created: 2, updated: 0 });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("DONE");
    expect(await leads(campaignId)).toHaveLength(2);
  });

  it("records a failure on the claim's own run, keeping earlier leads", async () => {
    // Seed a good scan, then claim and fail a second one.
    await scan(campaignId, returning([biz(1)]));
    const claim = await claimCampaignScan(prisma, campaignId);
    await expect(
      executeCampaignScan(prisma, claim, { getSource: failing(), analyze: fakeAnalyze })
    ).rejects.toBeInstanceOf(DiscoveryError);

    const run = await prisma.scanRun.findUniqueOrThrow({ where: { id: claim.scanId } });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(run.status).toBe("FAILED");
    expect(run.finishedAt).not.toBeNull();
    expect(campaign.status).toBe("FAILED");
    // The point of the whole design: the earlier lead survives.
    expect(await leads(campaignId)).toHaveLength(1);
  });

  it("keeps a scan that outlasts the stale window from being taken over", async () => {
    // Each website check takes most of the window, so the whole scan runs
    // well past it. Only a claim that is refreshed as work progresses stops a
    // second request from reading the live scan as crashed.
    const staleAfterMs = 1000;
    let clock = Date.now();
    const now = () => new Date(clock);
    const claim = await claimCampaignScan(prisma, campaignId, { now, staleAfterMs });

    let rival: unknown;
    let checked = 0;
    const slowAnalyze = async (business: DetectableBusiness) => {
      clock += 600;
      // The last of three checks: long past the window measured from the claim.
      if (++checked === 3) {
        rival = await claimCampaignScan(prisma, campaignId, { now, staleAfterMs }).catch((err: unknown) => err);
      }
      return fakeAnalyze(business);
    };

    await executeCampaignScan(prisma, claim, {
      getSource: returning([biz(1), biz(2), biz(3)]),
      analyze: slowAnalyze,
      concurrency: 1,
      staleAfterMs,
      now,
    });

    expect(rival).toBeInstanceOf(ScanConflictError);
    const run = await prisma.scanRun.findUniqueOrThrow({ where: { id: claim.scanId } });
    expect(run.status).toBe("SUCCEEDED");
  });

  it("frees the campaign for a normal rerun after a deferred scan failed", async () => {
    const claim = await claimCampaignScan(prisma, campaignId);
    await expect(
      executeCampaignScan(prisma, claim, { getSource: failing(), analyze: fakeAnalyze })
    ).rejects.toBeInstanceOf(DiscoveryError);

    // FAILED is not RUNNING, so the next claim succeeds without waiting out
    // the staleness window.
    await expect(scan(campaignId, returning([biz(1)]))).resolves.toMatchObject({ created: 1 });
  });
});
