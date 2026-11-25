import { afterAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import {
  fetchTrialStats,
  isMobile,
  orderPageCandidates,
  orderPageFit,
  orderPageOrigin,
  sellsParcelGoods,
  trialCode,
  trialLink,
} from "@/lib/orderPage";
import { draftFromTemplate } from "@/lib/templates";
import { createTestDb } from "./helpers/db";

const db = createTestDb();
const { prisma } = db;
process.env.DATABASE_URL = `file:${db.file.split(path.sep).join("/")}`;
delete process.env.ORDER_PAGE_URL;
delete process.env.ORDER_PAGE_STATS_KEY;

afterAll(async () => {
  const { prisma: appPrisma } = await import("@/lib/prisma");
  await appPrisma.$disconnect();
  await db.cleanup();
});

const ENV = { ORDER_PAGE_URL: "https://orders.example", ORDER_PAGE_STATS_KEY: "k" };

describe("sellsParcelGoods", () => {
  it.each(["clothes", "Clothing store", "women's clothing store", "shop=clothes", "shop=shoes, shop=cosmetics", "Butik", "dyqan këpucësh", "Kozmetikë", "parfumeri", "toy store", "book store", "watch store", "sports shop", "baby shop", "leather goods", "bags", "fabric store", "phone store", "dyqan dhuratash"])(
    "%s sells parcels",
    (niche) => expect(sellsParcelGoods(niche)).toBe("yes")
  );
  it.each(["dentist", "restaurant", "furniture", "florist", "shop=bakery", "cosmic ray lab", "workshoe", "boutique hotel", "cosmetic dentist", "cosmetic surgery", "shoe repair", "gift wrapping", "libraries", "sallon kozmetik"])("%s does not", (niche) =>
    expect(sellsParcelGoods(niche)).toBe("no")
  );
  it.each(["anything", "çdo biznes", "shop=*", "shop=clothes, shop=bakery", "shop", "dyqane"])("%s covers several kinds", (niche) =>
    expect(sellsParcelGoods(niche)).toBe("unknown")
  );
});

describe("isMobile", () => {
  it.each(["049 123 456", "+383 49 123 456", "+383 (0)44 123 456", "+383 049 123 456", "00383 45123456", "+355 69 123 4567", "069 123 4567", "038 200 200 / 045 123 456"])(
    "%s",
    (n) => expect(isMobile(n, "Prizren, Kosovo")).toBe(true)
  );
  it.each(["038 123 456", "+383 38 123 456", "+383 038749673", "+3834419636", "+355 4 123 4567", "+49 151 12345678", "", null, "abc"])("not %s", (n) =>
    expect(isMobile(n, "Prizren, Kosovo")).toBe(false)
  );
  it("takes a local 04x number for a mobile only in Kosovo", () => {
    for (const region of ["Prishtinë", "Pejë", "Suharek, Kosovo"]) expect(isMobile("04 4500 123", region)).toBe(true);
    for (const region of ["Tirana", "Albania", ""]) expect(isMobile("04 4500 123", region)).toBe(false);
    expect(isMobile("069 123 4567", "Tirana")).toBe(true);
  });
});

const shop = {
  name: "Butik Ana",
  phone: "049 123 456",
  instagram: "https://www.instagram.com/ana",
  websiteStatus: "NONE_FOUND",
  campaign: { niche: "clothes", region: "Prizren" },
};

describe("orderPageFit", () => {
  it("picks a reachable shop without a website, and says why", () => {
    expect(orderPageFit(shop)).toEqual({
      points: 9,
      reasons: ["On Instagram", "Mobile number, probably on WhatsApp", "Sells goods that go in a parcel"],
    });
  });
  it.each([
    ["has its own website", { websiteStatus: "GOOD" }],
    ["has a website that could not be checked", { websiteStatus: "NEEDS_CHECK" }],
    ["had its website found by the web search", { onlineCheck: "found" }],
    ["cannot be reached", { phone: null, instagram: null }],
    ["sells something else", { campaign: { niche: "dentist", region: "Prizren" } }],
  ])("leaves out one that %s", (_, change) => expect(orderPageFit({ ...shop, ...change })).toBeNull());

  it("judges by name in a campaign for anything, and says it is a guess", () => {
    const any = { campaign: { niche: "anything", region: "Prizren" } };
    expect(orderPageFit({ ...shop, ...any })!.reasons).toContain("Its name suggests goods that go in a parcel (check)");
    expect(orderPageFit({ ...shop, ...any, name: "Pizzeria Era" })).toBeNull();
    expect(orderPageFit({ ...shop, ...any, name: "Dr. Dhurata Hoxha" })).toBeNull();
    expect(orderPageFit({ ...shop, ...any, name: "Boutique Hotel Prizreni" })).toBeNull();
  });
});

describe("links", () => {
  it("are stable, different per lead, and do not contain the lead's id", () => {
    expect(trialCode("abc")).toBe(trialCode("abc"));
    expect(trialCode("abc")).not.toBe(trialCode("abd"));
    // The form the order page accepts as a link code.
    expect(trialCode("abc")).toMatch(/^[a-z0-9-]{1,24}$/);
    expect(trialLink("cmabc123", ENV)).not.toContain("cmabc123");
  });
  it("need a plain https address", () => {
    expect(orderPageOrigin({ ORDER_PAGE_URL: "https://orders.example/x?y" })).toBe("https://orders.example");
    for (const bad of [undefined, "", "orders.example", "http://orders.example", "javascript:alert(1)", "https://u:p@orders.example"]) {
      expect(orderPageOrigin({ ORDER_PAGE_URL: bad })).toBeNull();
    }
    expect(trialLink("abc", {})).toBeNull();
  });
});

describe("fetchTrialStats", () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  const refs = { gx: { view: 2, demo: 1, demo_add: 1, demo_order: 1, signup: 0 } };

  it("reads the counts, with the key, without following redirects", async () => {
    let call: [unknown, RequestInit] | undefined;
    const spy = (async (url: unknown, init: RequestInit) => {
      call = [url, init];
      return new Response(JSON.stringify({ refs, signups: [] }));
    }) as typeof fetch;
    const { stats, problem } = await fetchTrialStats(ENV, spy);
    expect(problem).toBeNull();
    expect(stats!.gx).toEqual({ view: 2, demo: 1, demo_order: 1, signup: 0 });
    expect(call![0]).toBe("https://orders.example/api/stats");
    expect(call![1]).toMatchObject({ headers: { authorization: "Bearer k" }, redirect: "error" });
  });
  it.each([
    ["not configured", {}, answer(200, { refs })],
    ["no key", { ORDER_PAGE_URL: ENV.ORDER_PAGE_URL }, answer(200, { refs })],
    ["an address that is not https", { ORDER_PAGE_URL: "orders.example" }, answer(200, { refs })],
    ["a wrong key", ENV, answer(401, {})],
    ["a server error", ENV, answer(500, {})],
    ["an unexpected answer", ENV, answer(200, { refs: { gx: { view: "2" } } })],
    ["no connection", ENV, (async () => Promise.reject(new Error("k"))) as unknown as typeof fetch],
  ])("says so with %s, and never shows the key", async (_, env, fetcher) => {
    const { stats, problem } = await fetchTrialStats(env as Record<string, string>, fetcher);
    expect(stats).toBeNull();
    expect(problem).toMatch(/\.$/);
    expect(problem).not.toContain("Bearer");
  });
});

describe("with a database", () => {
  let campaignId: string;
  beforeEach(async () => {
    await prisma.outreach.deleteMany();
    await prisma.messageTemplate.deleteMany();
    await prisma.doNotContact.deleteMany();
    await prisma.campaign.deleteMany();
    campaignId = (await prisma.campaign.create({ data: { name: "Clothes", region: "Prizren", niche: "clothes", language: "sq" } })).id;
  });
  const add = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.business.create({
      data: { campaignId, name, dedupeKey: name, websiteStatus: "NONE_FOUND", phone: "049 123 456", ...extra },
    });

  it("lists shops best first, with their visits, leaving out dead leads", async () => {
    const low = await add("Low", { phone: "038 200 200" });
    const high = await add("High", { phone: "044 111 222", instagram: "https://www.instagram.com/high" });
    await add("Dead", { phone: "044 111 333", crmStage: "DEAD" });
    const stats = { [trialCode(low.id)]: { view: 3, demo: 1, demo_order: 0, signup: 1 } };
    const list = await orderPageCandidates(prisma, stats, ENV);
    expect(list.map((c) => c.name)).toEqual(["High", "Low"]);
    expect(list[0]).toMatchObject({ visits: { view: 0 }, link: trialLink(high.id, ENV) });
    expect(list[1].visits).toMatchObject({ view: 3, signup: 1 });
  });
  it("does not show unread counts as zero", async () => {
    await add("A");
    expect((await orderPageCandidates(prisma, null, ENV))[0].visits).toBeNull();
  });
  it("lists a shop found twice once, keeping the copy already contacted", async () => {
    await add("Ana", { score: 50 });
    const contacted = await add("Ana Butik", { phone: "+383 49 123 456", crmStage: "CONTACTED" });
    const list = await orderPageCandidates(prisma, null, ENV);
    expect(list.map((c) => c.leadId)).toEqual([contacted.id]);
  });

  describe("a shop that several campaigns found", () => {
    const names = async (stats: Parameters<typeof orderPageCandidates>[1] = null) =>
      (await orderPageCandidates(prisma, stats, ENV)).map((c) => c.name);

    it.each([
      ["said no", { crmStage: "DEAD" }],
      ["is a customer", { crmStage: "DELIVERED" }],
      ["has a website", { websiteStatus: "GOOD", website: "https://ana.example" }],
      ["had its website found", { onlineCheck: "found" }],
    ])("is left out when one copy %s", async (_, change) => {
      await add("Ana", change);
      await add("Ana Butik");
      await add("Other", { phone: "044 999 888" });
      expect(await names()).toEqual(["Other"]);
    });
    it("is left out when its address opted out", async () => {
      await prisma.doNotContact.create({ data: { value: "ana.example" } });
      await add("Ana", { email: "info@ana.example" });
      await add("Ana Butik");
      expect(await names()).toEqual([]);
    });
    it("shows the copy furthest along, not the higher score", async () => {
      await add("Qualified", { crmStage: "QUALIFIED", score: 80 });
      await add("Contacted", { crmStage: "CONTACTED", score: 50 });
      expect(await names()).toEqual(["Contacted"]);
    });
    it("prefers a copy whose link was opened to one only qualified", async () => {
      await add("Qualified", { crmStage: "QUALIFIED", score: 80 });
      const opened = await add("Opened");
      expect(await names({ [trialCode(opened.id)]: { view: 1, demo: 0, demo_order: 0, signup: 0 } })).toEqual(["Opened"]);
    });
    it("joins what the copies know, through a third, and adds up their visits", async () => {
      const a = await add("A", { crmStage: "CONTACTED" });
      const b = await add("B", { instagram: "https://www.instagram.com/Ana" });
      await add("C", { phone: null, instagram: "https://www.instagram.com/ana", facebook: "https://www.facebook.com/ana" });
      const stats = {
        [trialCode(a.id)]: { view: 1, demo: 0, demo_order: 0, signup: 0 },
        [trialCode(b.id)]: { view: 2, demo: 1, demo_order: 1, signup: 1 },
      };
      const list = await orderPageCandidates(prisma, stats, ENV);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ name: "A", visits: { view: 3, demo: 1, demo_order: 1, signup: 1 }, facebook: "https://www.facebook.com/ana" });
      expect(list[0].instagram!.toLowerCase()).toBe("https://www.instagram.com/ana");
      expect(list[0].link).toBe(trialLink(a.id, ENV));
    });
    it("keeps two shops apart when they share a number but not a page", async () => {
      await add("One", { instagram: "https://www.instagram.com/one" });
      await add("Two", { instagram: "https://www.instagram.com/two" });
      expect(await names()).toEqual(["One", "Two"]);
    });
  });
  it("carries the email of a shop reachable only by email", async () => {
    await add("Mail", { phone: null, email: "info@mail.example" });
    expect((await orderPageCandidates(prisma, null, ENV))[0]).toMatchObject({ email: "info@mail.example", phone: null });
  });

  describe("{{order_page}} in a template", () => {
    const draft = async (niche: string) => {
      await prisma.campaign.update({ where: { id: campaignId }, data: { niche } });
      await prisma.messageTemplate.create({ data: { language: "sq", channel: "message", gapKey: "no_website", body: "Provoje: {{order_page}}" } });
      const { id } = await add("Ana", { signals: { create: { key: "no_website", label: "No website", severity: 40 } } });
      const lead = await prisma.business.findUniqueOrThrow({ where: { id }, include: { signals: true, campaign: true } });
      return { id, result: await draftFromTemplate(prisma, lead, "message").catch((e: Error) => e) };
    };
    it("is the shop's own link", async () => {
      process.env.ORDER_PAGE_URL = ENV.ORDER_PAGE_URL;
      const { id, result } = await draft("clothes");
      expect(result).toMatchObject({ body: `Provoje: ${trialLink(id, ENV)}` });
      delete process.env.ORDER_PAGE_URL;
    });
    it("is never offered to a business it does not fit", async () => {
      process.env.ORDER_PAGE_URL = ENV.ORDER_PAGE_URL;
      expect((await draft("dentist")).result).toMatchObject({ kind: "no_template" });
      delete process.env.ORDER_PAGE_URL;
    });
    it("skips the template when no order page is set", async () => {
      expect((await draft("clothes")).result).toMatchObject({ kind: "no_template" });
    });
  });

  it("exports the list, leaving unread counts empty", async () => {
    await add("=Ana", { instagram: "https://www.instagram.com/ana" });
    const { GET } = await import("@/app/api/order-page/export/route");
    const res = await GET();
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="order-page-shops.csv"');
    const [header, row] = (await res.text()).split("\r\n");
    expect(header).toMatch(/^name,instagram,.*signed_up$/);
    expect(row).toMatch(/^'=Ana,https:\/\/www\.instagram\.com\/ana,.*,,,,,$/);
  });
});
