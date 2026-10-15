import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rescoreCampaign } from "@/lib/rescore";
import { CampaignNotFoundError } from "@/lib/scan";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

let campaignId: string;
beforeEach(async () => {
  campaignId = (await prisma.campaign.create({ data: { name: "Dentists", region: "Tirana", niche: "dentist" } })).id;
});

/** A lead as an earlier version of the scoring left it: signals stored, score stale. */
async function lead(n: number, data: { score: number; phone?: string; email?: string }, signals: object[]) {
  return prisma.business.create({
    data: {
      campaignId,
      name: `Business ${n}`,
      dedupeKey: `k${n}`,
      crmStage: "CONTACTED",
      notes: "called Monday",
      ...data,
      signals: { create: signals as { key: string; label: string; severity: number; certainty?: string }[] },
    },
  });
}
const NO_WEBSITE = { key: "no_website", label: "No website found", severity: 40 };

describe("rescoreCampaign", () => {
  it("recomputes scores from stored signals and contact details", async () => {
    const stale = await lead(1, { score: 44, phone: "+355 1", email: "a@b.al" }, [NO_WEBSITE]);
    expect(await rescoreCampaign(prisma, campaignId)).toEqual({ rescored: 1, changed: 1 });
    // 40 * (1 + 0.1 phone + 0.1 email): the email earned nothing when 44 was stored.
    expect((await prisma.business.findUniqueOrThrow({ where: { id: stale.id } })).score).toBe(48);
  });

  it("keeps a stored signal's certainty, so an unverified gap still counts for half", async () => {
    const id = (
      await lead(1, { score: 0 }, [{ key: "site_unreachable", label: "Did not load", severity: 35, certainty: "UNCERTAIN" }])
    ).id;
    await rescoreCampaign(prisma, campaignId);
    expect((await prisma.business.findUniqueOrThrow({ where: { id } })).score).toBe(17.5);
  });

  it("counts only the scores that actually moved", async () => {
    await lead(1, { score: 40 }, [NO_WEBSITE]);
    await lead(2, { score: 0, phone: "+355 1" }, [NO_WEBSITE]);
    expect(await rescoreCampaign(prisma, campaignId)).toEqual({ rescored: 2, changed: 1 });
  });

  it("writes nothing but the score", async () => {
    const before = await lead(1, { score: 0 }, [NO_WEBSITE]);
    await rescoreCampaign(prisma, campaignId);
    const after = await prisma.business.findUniqueOrThrow({ where: { id: before.id }, include: { signals: true } });
    expect(after).toMatchObject({ crmStage: "CONTACTED", notes: "called Monday", score: 40 });
    expect(after.signals.map((s) => s.key)).toEqual(["no_website"]);
  });

  it("leaves other campaigns alone", async () => {
    const other = await prisma.campaign.create({ data: { name: "Other", region: "Durres", niche: "cafe" } });
    const untouched = await prisma.business.create({
      data: { campaignId: other.id, name: "Cafe", dedupeKey: "c", score: 0, signals: { create: [NO_WEBSITE] } },
    });
    await rescoreCampaign(prisma, campaignId);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: untouched.id } })).score).toBe(0);
  });

  it("refuses a campaign that does not exist", async () => {
    await expect(rescoreCampaign(prisma, "no-such-campaign")).rejects.toBeInstanceOf(CampaignNotFoundError);
  });
});
