import { afterAll, describe, expect, it } from "vitest";
import { campaignUpdateSchema, deleteCampaign, updateCampaign } from "@/lib/campaigns";
import { CampaignNotFoundError, claimCampaignScan, ScanConflictError } from "@/lib/scan";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

async function campaignWithLead() {
  const campaign = await prisma.campaign.create({ data: { name: "Tirana dentsits", region: "Tirana", niche: "dentist" } });
  const lead = await prisma.business.create({
    data: {
      campaignId: campaign.id,
      name: "Klinika",
      dedupeKey: `k${Math.random()}`,
      crmStage: "CONTACTED",
      notes: "called",
      signals: { create: [{ key: "no_website", label: "No website found", severity: 40 }] },
      outreach: { create: [{ subject: "s", openLine: "o", body: "b" }] },
      stageChanges: { create: [{ fromStage: "NEW", toStage: "CONTACTED" }] },
    },
  });
  return { campaign, lead };
}

describe("campaignUpdateSchema", () => {
  it("accepts a new name, a language, or both", () => {
    expect(campaignUpdateSchema.safeParse({ name: " Tirana dentists " }).data).toEqual({ name: "Tirana dentists" });
    expect(campaignUpdateSchema.safeParse({ language: "sq" }).success).toBe(true);
  });

  it.each([{}, { name: "" }, { name: "x".repeat(121) }, { language: "xx" }])("rejects %j", (body) => {
    expect(campaignUpdateSchema.safeParse(body).success).toBe(false);
  });
});

describe("updateCampaign", () => {
  it("renames a campaign and changes its language without touching its leads", async () => {
    const { campaign, lead } = await campaignWithLead();
    const updated = await updateCampaign(prisma, campaign.id, { name: "Tirana dentists", language: "sq" });
    expect(updated).toMatchObject({ name: "Tirana dentists", language: "sq", region: "Tirana" });
    expect(await prisma.business.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      crmStage: "CONTACTED",
      notes: "called",
    });
  });

  it("reports an unknown campaign", async () => {
    await expect(updateCampaign(prisma, "nope", { name: "x" })).rejects.toBeInstanceOf(CampaignNotFoundError);
  });
});

describe("deleteCampaign", () => {
  it("deletes the campaign and everything in it", async () => {
    const { campaign, lead } = await campaignWithLead();
    await deleteCampaign(prisma, campaign.id);
    expect(await prisma.campaign.findUnique({ where: { id: campaign.id } })).toBeNull();
    expect(await prisma.business.count({ where: { id: lead.id } })).toBe(0);
    expect(await prisma.gapSignal.count({ where: { businessId: lead.id } })).toBe(0);
    expect(await prisma.outreach.count({ where: { businessId: lead.id } })).toBe(0);
    expect(await prisma.stageChange.count({ where: { businessId: lead.id } })).toBe(0);
  });

  it("leaves other campaigns alone", async () => {
    const keep = await campaignWithLead();
    const drop = await campaignWithLead();
    await deleteCampaign(prisma, drop.campaign.id);
    expect(await prisma.business.count({ where: { campaignId: keep.campaign.id } })).toBe(1);
  });

  it("refuses while a scan holds the campaign, and keeps everything", async () => {
    const { campaign } = await campaignWithLead();
    await claimCampaignScan(prisma, campaign.id);
    await expect(deleteCampaign(prisma, campaign.id)).rejects.toBeInstanceOf(ScanConflictError);
    expect(await prisma.business.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it("still deletes a campaign whose scan crashed long ago", async () => {
    const { campaign } = await campaignWithLead();
    await claimCampaignScan(prisma, campaign.id);
    const later = () => new Date(Date.now() + 60 * 60 * 1000);
    await deleteCampaign(prisma, campaign.id, { now: later });
    expect(await prisma.campaign.findUnique({ where: { id: campaign.id } })).toBeNull();
  });

  it("reports an unknown campaign", async () => {
    await expect(deleteCampaign(prisma, "nope")).rejects.toBeInstanceOf(CampaignNotFoundError);
  });
});

describe("updateCampaign and the scan claim", () => {
  it("does not touch updatedAt, which tells a crashed scan from a live one", async () => {
    const { campaign } = await campaignWithLead();
    await claimCampaignScan(prisma, campaign.id);
    const before = (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).updatedAt;
    await new Promise((r) => setTimeout(r, 20));
    await updateCampaign(prisma, campaign.id, { name: "Renamed while stuck" });
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.name).toBe("Renamed while stuck");
    expect(after.updatedAt).toEqual(before);
  });
});
