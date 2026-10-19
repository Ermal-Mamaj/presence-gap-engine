import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { draftForLead } from "@/lib/drafting";
import { OutreachError } from "@/lib/outreach";
import {
  createTemplate,
  deleteTemplate,
  draftFromTemplate,
  templateInputSchema,
  TemplateNotFoundError,
  updateTemplate,
} from "@/lib/templates";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());

let campaignId: string;
beforeEach(async () => {
  await prisma.outreach.deleteMany();
  await prisma.messageTemplate.deleteMany();
  campaignId = (
    await prisma.campaign.create({ data: { name: "Dentists", region: "Tirana", niche: "Dentist", language: "sq" } })
  ).id;
});

type Gap = { key: string; severity: number; certainty?: string };
async function lead(name: string, gaps: Gap[] = [{ key: "no_website", severity: 40 }], extra: Record<string, unknown> = {}) {
  const created = await prisma.business.create({
    data: {
      campaignId,
      name,
      dedupeKey: `${name}${Math.random()}`,
      signals: { create: gaps.map((g) => ({ ...g, label: g.key })) },
      ...extra,
    },
  });
  return prisma.business.findUniqueOrThrow({ where: { id: created.id }, include: { signals: true, campaign: true } });
}

const template = (overrides: Record<string, unknown> = {}) =>
  createTemplate(
    prisma,
    templateInputSchema.parse({
      language: "sq",
      channel: "email",
      gapKey: "no_website",
      subject: "Faqe për {{name}}",
      body: "Përshëndetje {{name}}, ...",
      ...overrides,
    })
  );

describe("templateInputSchema", () => {
  it("normalizes the business type and an empty subject", () => {
    const parsed = templateInputSchema.parse({
      language: "sq",
      channel: "message",
      gapKey: "no_website",
      niche: " Dentist ",
      subject: "",
      body: "Hi {{name}}",
    });
    expect(parsed).toMatchObject({ niche: "dentist", subject: null, active: true });
  });

  it.each([
    ["an email without a subject", { channel: "email", subject: "" }, "needs a subject"],
    ["an unknown placeholder", { body: "Hi {{owner}}" }, "Unknown placeholder"],
    ["a gap that is never stated", { gapKey: "site_unreachable" }, "gapKey"],
    ["an unknown language", { language: "xx" }, "language"],
  ])("refuses %s", (_name, overrides, message) => {
    const result = templateInputSchema.safeParse({
      language: "sq",
      channel: "email",
      gapKey: "no_website",
      subject: "s",
      body: "b",
      ...overrides,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(message);
  });
});

describe("draftFromTemplate", () => {
  it("fills the template written for the lead's gap, language and channel", async () => {
    const t = await template();
    const draft = await draftFromTemplate(prisma, await lead("Klinika Arbëri"), "email");
    expect(draft).toEqual({
      templateId: t.id,
      gapKey: "no_website",
      subject: "Faqe për Klinika Arbëri",
      body: "Përshëndetje Klinika Arbëri, ...",
    });
  });

  it("writes about the most severe verified gap that has a template", async () => {
    await template({ gapKey: "no_mobile_viewport", body: "mobile {{name}}" });
    await template({ gapKey: "not_https", body: "https {{name}}" });
    const target = await lead("A", [
      { key: "not_https", severity: 15 },
      { key: "no_mobile_viewport", severity: 15 },
      { key: "site_unreachable", severity: 35, certainty: "UNCERTAIN" },
      { key: "stale_site", severity: 10 },
    ]);
    // stale_site has no template, the uncertain one is never stated; of the
    // two equal ones the order of the stored signals decides.
    expect((await draftFromTemplate(prisma, target, "email")).body).toBe("https A");
  });

  it("prefers a template written for the campaign's business type", async () => {
    await template({ body: "generic {{name}}" });
    await template({ body: "for dentists {{name}}", niche: "dentist" });
    await template({ body: "for lawyers {{name}}", niche: "lawyer" });
    expect((await draftFromTemplate(prisma, await lead("A"), "email")).body).toBe("for dentists A");
  });

  it("rotates variants across a campaign, least used first", async () => {
    await template({ body: "one {{name}}" });
    await template({ body: "two {{name}}" });
    const bodies: string[] = [];
    for (const name of ["A", "B", "C"]) {
      const saved = await draftForLead(prisma, await lead(name), { channel: "email", source: "templates" });
      bodies.push(saved.body);
    }
    expect(bodies).toEqual(["one A", "two B", "one C"]);
  });

  it("passes over a template that needs a value the lead lacks", async () => {
    await template({ body: "Your site {{website}} ..." });
    await template({ body: "No website for {{name}}" });
    expect((await draftFromTemplate(prisma, await lead("A"), "email")).body).toBe("No website for A");
  });

  it("ignores inactive templates and other languages or channels", async () => {
    await template({ active: false });
    await template({ language: "en" });
    await template({ channel: "message", subject: null });
    await expect(draftFromTemplate(prisma, await lead("A"), "email")).rejects.toMatchObject({ kind: "no_template" });
  });

  it("says which template is missing", async () => {
    const error = await draftFromTemplate(prisma, await lead("A"), "phone").catch((e) => e);
    expect(error).toBeInstanceOf(OutreachError);
    expect(error.message).toBe(
      'No Albanian call script template fits this lead yet. Its main gap is "The listing has no website"; add a template for it under Templates.'
    );
  });

  it("refuses a lead with nothing verified to say, before looking for a template", async () => {
    await template();
    const target = await lead("A", [{ key: "site_unreachable", severity: 35, certainty: "UNCERTAIN" }]);
    await expect(draftFromTemplate(prisma, target, "email")).rejects.toMatchObject({ kind: "no_verified_gaps" });
  });
});

describe("draftForLead from a template", () => {
  it("stores the filled text, the channel and the template it came from", async () => {
    const t = await template({ body: "Line one {{name}}\nLine two" });
    const saved = await draftForLead(prisma, await lead("A"), { channel: "email", source: "templates" });
    expect(saved).toMatchObject({
      templateId: t.id,
      channel: "email",
      subject: "Faqe për A",
      openLine: "Line one A",
      body: "Line one A\nLine two",
    });
  });
});

describe("editing templates", () => {
  it("updates and deletes, and a draft keeps its text when its template goes", async () => {
    const t = await template();
    const saved = await draftForLead(prisma, await lead("A"), { channel: "email", source: "templates" });
    const edited = await updateTemplate(
      prisma,
      t.id,
      templateInputSchema.parse({ language: "sq", channel: "email", gapKey: "no_website", subject: "S", body: "New {{name}}" })
    );
    expect(edited.body).toBe("New {{name}}");
    await deleteTemplate(prisma, t.id);
    expect(await prisma.outreach.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({
      templateId: null,
      body: "Përshëndetje A, ...",
    });
  });

  it("reports an unknown template", async () => {
    const input = templateInputSchema.parse({ language: "sq", channel: "email", gapKey: "no_website", subject: "s", body: "b" });
    await expect(updateTemplate(prisma, "nope", input)).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(deleteTemplate(prisma, "nope")).rejects.toBeInstanceOf(TemplateNotFoundError);
  });
});

describe("draftFromTemplate: a campaign for anything", () => {
  it("doesn't call the business 'anything', and uses a template that doesn't name a type", async () => {
    await prisma.campaign.update({ where: { id: campaignId }, data: { niche: "Anything" } });
    await template({ body: "Pyetje për {{business_type}} në {{area}}" }); // needs a type: skipped
    const plain = await template({ body: "Përshëndetje {{name}}" });
    const draft = await draftFromTemplate(prisma, await lead("Furra Pashtriku"), "email");
    expect(draft.templateId).toBe(plain.id);
    expect(draft.body).not.toMatch(/anything/i);
  });
});
