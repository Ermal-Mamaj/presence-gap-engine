import type { Transporter } from "nodemailer";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDoNotContact, isDoNotContact, mailStatus, normalizeBlockValue, sendDraftEmail } from "@/lib/mail";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
afterAll(() => db.cleanup());
afterEach(() => vi.unstubAllEnvs());

function configure(extra: Record<string, string> = {}) {
  vi.stubEnv("SMTP_URL", "smtp://unused.example");
  vi.stubEnv("MAIL_FROM", "Naser <naser@outreach.example>");
  vi.stubEnv("MAIL_OPT_OUT", "[opt-out line]");
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

/** A mail server stand-in that records what it was asked to send. */
function fakeTransport(fail?: string) {
  const sent: Record<string, unknown>[] = [];
  const transport = {
    sendMail: vi.fn(async (message: Record<string, unknown>) => {
      if (fail) throw new Error(fail);
      sent.push(message);
      return { messageId: "<abc@outreach.example>" };
    }),
  } as unknown as Transporter;
  return { transport, sent };
}

let campaignId: string;
beforeEach(async () => {
  await prisma.doNotContact.deleteMany();
  await prisma.outreach.deleteMany();
  campaignId = (await prisma.campaign.create({ data: { name: "c", region: "r", niche: "n" } })).id;
});

async function emailDraft(data: { email?: string | null; channel?: string; sentAt?: Date } = {}) {
  const lead = await prisma.business.create({
    data: { campaignId, name: "Klinika", dedupeKey: `k${Math.random()}`, email: data.email === undefined ? "info@klinika.al" : data.email },
  });
  return prisma.outreach.create({
    data: { businessId: lead.id, channel: data.channel ?? "email", subject: "Faqe", openLine: "o", body: "Përshëndetje", sentAt: data.sentAt },
  });
}

describe("sendDraftEmail", () => {
  it("sends with the opt-out line and an unsubscribe header, then records it as sent", async () => {
    configure();
    const draft = await emailDraft();
    const { transport, sent } = fakeTransport();
    const outcome = await sendDraftEmail(prisma, draft.id, { transport, today: "2026-10-15" });

    expect(sent).toEqual([
      {
        from: "Naser <naser@outreach.example>",
        to: "info@klinika.al",
        subject: "Faqe",
        text: "Përshëndetje\n\n[opt-out line]",
        headers: { "List-Unsubscribe": "<mailto:naser@outreach.example?subject=unsubscribe>" },
      },
    ]);
    expect(outcome).toMatchObject({ dryRun: false, messageId: "<abc@outreach.example>" });
    const saved = await prisma.outreach.findUniqueOrThrow({ where: { id: draft.id }, include: { business: true } });
    expect(saved).toMatchObject({ sentVia: "app_email", emailMessageId: "<abc@outreach.example>" });
    expect(saved.sentAt).not.toBeNull();
    expect(saved.business.crmStage).toBe("CONTACTED");
  });

  it.each([
    ["a draft for another channel", { channel: "phone" }, "not_email"],
    ["a lead without an address", { email: null }, "no_address"],
    ["a draft already sent", { sentAt: new Date() }, "already_sent"],
  ])("refuses %s without sending", async (_name, data, kind) => {
    configure();
    const draft = await emailDraft(data);
    const { transport, sent } = fakeTransport();
    await expect(sendDraftEmail(prisma, draft.id, { transport })).rejects.toMatchObject({ kind });
    expect(sent).toEqual([]);
  });

  it("refuses an address, or a whole domain, on the do-not-contact list", async () => {
    configure();
    const { transport, sent } = fakeTransport();
    await addDoNotContact(prisma, "INFO@klinika.al");
    await expect(sendDraftEmail(prisma, (await emailDraft()).id, { transport })).rejects.toMatchObject({ kind: "do_not_contact" });
    await addDoNotContact(prisma, "other.al");
    await expect(sendDraftEmail(prisma, (await emailDraft({ email: "x@other.al" })).id, { transport })).rejects.toMatchObject({
      kind: "do_not_contact",
    });
    expect(sent).toEqual([]);
  });

  it("refuses to send without an opt-out line, naming what's missing", async () => {
    configure({ MAIL_OPT_OUT: "" });
    const { transport } = fakeTransport();
    await expect(sendDraftEmail(prisma, (await emailDraft()).id, { transport })).rejects.toMatchObject({
      kind: "not_configured",
      message: expect.stringContaining("MAIL_OPT_OUT"),
    });
  });

  it("stops at the daily limit", async () => {
    configure({ MAIL_DAILY_LIMIT: "1" });
    const { transport } = fakeTransport();
    await sendDraftEmail(prisma, (await emailDraft()).id, { transport });
    await expect(sendDraftEmail(prisma, (await emailDraft()).id, { transport })).rejects.toMatchObject({ kind: "daily_limit" });
  });

  it("leaves the draft unsent when the mail server refuses it", async () => {
    configure();
    const draft = await emailDraft();
    const { transport } = fakeTransport("550 relay denied");
    await expect(sendDraftEmail(prisma, draft.id, { transport })).rejects.toMatchObject({
      kind: "send_failed",
      message: expect.stringContaining("550 relay denied"),
    });
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: draft.id } })).sentAt).toBeNull();
  });

  it("builds a dry run exactly, and records nothing", async () => {
    configure({ MAIL_DRY_RUN: "1", SMTP_URL: "" });
    const draft = await emailDraft();
    const outcome = await sendDraftEmail(prisma, draft.id);
    expect(outcome).toMatchObject({ dryRun: true, to: "info@klinika.al", text: "Përshëndetje\n\n[opt-out line]" });
    expect((await prisma.outreach.findUniqueOrThrow({ where: { id: draft.id } })).sentAt).toBeNull();
  });

  it("sends once when asked twice at the same moment", async () => {
    configure();
    const draft = await emailDraft();
    const { transport, sent } = fakeTransport();
    const results = await Promise.allSettled([
      sendDraftEmail(prisma, draft.id, { transport }),
      sendDraftEmail(prisma, draft.id, { transport }),
    ]);
    expect(sent).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("mailStatus and the do-not-contact list", () => {
  it("says what is missing, and never the SMTP URL", async () => {
    vi.stubEnv("SMTP_URL", "smtps://user:secret@smtp.example");
    const status = await mailStatus(prisma);
    expect(status).toMatchObject({ ready: false, missing: ["MAIL_FROM", "MAIL_OPT_OUT"], dailyLimit: 20 });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("accepts an address or a domain, and nothing else", () => {
    expect(normalizeBlockValue(" Info@Klinika.AL ")).toBe("info@klinika.al");
    expect(normalizeBlockValue("@klinika.al")).toBe("klinika.al");
    expect(normalizeBlockValue("not a thing")).toBeNull();
  });

  it("matches the list without regard to case", async () => {
    await addDoNotContact(prisma, "klinika.al");
    expect(await isDoNotContact(prisma, "Dr@KLINIKA.al")).toBe(true);
    expect(await isDoNotContact(prisma, "dr@klinika.com")).toBe(false);
  });
});
