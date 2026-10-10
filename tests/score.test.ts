import { describe, expect, it } from "vitest";
import type { Certainty, DetectedSignal } from "@/lib/detect";
import { computeScore, explainScore, MAX_SCORE } from "@/lib/score";

const sig = (key: string, severity: number, certainty: Certainty = "VERIFIED"): DetectedSignal => ({
  key,
  label: key,
  severity,
  certainty,
});

const NO_WEBSITE = [sig("no_website", 40)];

describe("computeScore: baseline behaviour", () => {
  it("scores 0 when there is no gap, however healthy the business", () => {
    expect(computeScore([], { rating: 5, reviewCount: 500, phone: "123" })).toBe(0);
  });

  it("scores a gap on a business with no viability data at its face value", () => {
    expect(computeScore(NO_WEBSITE, {})).toBe(40);
  });

  it("adds the phone credit", () => {
    expect(computeScore(NO_WEBSITE, { phone: "+355 69 000 0000" })).toBe(44);
  });

  it("treats a blank or whitespace phone as missing", () => {
    expect(computeScore(NO_WEBSITE, { phone: "   " })).toBe(computeScore(NO_WEBSITE, { phone: null }));
    expect(computeScore(NO_WEBSITE, { phone: "" })).toBe(40);
  });

  it("scores a realistic listing with an explainable multiplier", () => {
    const signals = [sig("no_mobile_viewport", 15), sig("not_https", 15)];
    const breakdown = explainScore(signals, { rating: 4.4, reviewCount: 120, phone: "+383 29 000 000" });
    expect(breakdown.gapPoints).toBe(30);
    expect(breakdown.reviewCredit).toBeCloseTo(0.5431, 3);
    expect(breakdown.ratingCredit).toBeCloseTo(0.264, 3);
    expect(breakdown.phoneCredit).toBe(0.1);
    expect(breakdown.ghostPenaltyApplied).toBe(false);
    expect(breakdown.score).toBeCloseTo(57.21, 2);
  });

  it("ranks a viable business above an equally-gapped but unproven one", () => {
    const viable = computeScore(NO_WEBSITE, { rating: 4.5, reviewCount: 80, phone: "1" });
    const unproven = computeScore(NO_WEBSITE, { reviewCount: 0, rating: 0 });
    expect(viable).toBeGreaterThan(unproven);
  });
});

describe("computeScore: zero versus unknown", () => {
  it("does not treat an unknown review count and rating as an empty listing", () => {
    // OpenStreetMap never reports reviews; that says nothing about the business.
    expect(explainScore(NO_WEBSITE, {}).ghostPenaltyApplied).toBe(false);
    expect(computeScore(NO_WEBSITE, { reviewCount: null, rating: null })).toBe(40);
  });

  it("treats a reported 0 reviews and no phone as a likely ghost listing", () => {
    const breakdown = explainScore(NO_WEBSITE, { reviewCount: 0 });
    expect(breakdown.ghostPenaltyApplied).toBe(true);
    expect(breakdown.score).toBe(20);
  });

  it("treats a rating of 0 as unrated, which is different from a missing rating", () => {
    expect(explainScore(NO_WEBSITE, { rating: 0 }).ghostPenaltyApplied).toBe(true);
    expect(explainScore(NO_WEBSITE, { rating: null }).ghostPenaltyApplied).toBe(false);
    expect(explainScore(NO_WEBSITE, { rating: 0 }).ratingCredit).toBe(0);
  });

  it("does not penalise an empty listing when there is a phone number", () => {
    const breakdown = explainScore(NO_WEBSITE, { reviewCount: 0, rating: 0, phone: "1" });
    expect(breakdown.ghostPenaltyApplied).toBe(false);
    expect(breakdown.score).toBe(44);
  });

  it("does not penalise when either reviews or rating is positive", () => {
    expect(explainScore(NO_WEBSITE, { reviewCount: 3, rating: 0 }).ghostPenaltyApplied).toBe(false);
    expect(explainScore(NO_WEBSITE, { reviewCount: 0, rating: 4 }).ghostPenaltyApplied).toBe(false);
  });
});

describe("computeScore: review volume credit", () => {
  const credit = (reviewCount: number) => explainScore(NO_WEBSITE, { reviewCount }).reviewCredit;

  it("grows with review count and never decreases", () => {
    const counts = [0, 1, 2, 5, 10, 50, 100, 199, 1_000, 1_000_000];
    const credits = counts.map(credit);
    for (let i = 1; i < credits.length; i++) expect(credits[i]).toBeGreaterThanOrEqual(credits[i - 1]);
  });

  it("gives diminishing returns: the first reviews matter more than the 150th", () => {
    expect(credit(10) - credit(1)).toBeGreaterThan(credit(200) - credit(100));
  });

  it("is capped, so a huge business does not dwarf everything else", () => {
    expect(credit(200)).toBeCloseTo(0.6, 6);
    expect(credit(10_000_000)).toBeCloseTo(0.6, 6);
  });

  it("gives no credit for zero reviews", () => {
    expect(credit(0)).toBe(0);
  });
});

describe("computeScore: invalid input never produces an invalid score", () => {
  it.each([
    ["rating above 5", { rating: 7, reviewCount: 10 }],
    ["negative rating", { rating: -2, reviewCount: 10 }],
    ["NaN rating", { rating: NaN, reviewCount: 10 }],
    ["Infinity rating", { rating: Infinity, reviewCount: 10 }],
    ["negative review count", { rating: 4, reviewCount: -50 }],
    ["NaN review count", { rating: 4, reviewCount: NaN }],
    ["Infinity review count", { rating: 4, reviewCount: Infinity }],
  ])("ignores %s", (_name, business) => {
    const score = computeScore(NO_WEBSITE, business);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(MAX_SCORE);
  });

  it("does not reward a corrupt rating", () => {
    expect(explainScore(NO_WEBSITE, { rating: 7 }).ratingCredit).toBe(0);
  });

  it("ignores signals with a non-finite or negative severity", () => {
    const signals = [sig("a", NaN), sig("b", -10), sig("c", Infinity), sig("d", 20)];
    expect(computeScore(signals, {})).toBe(20);
  });

  it("clamps to the maximum score", () => {
    const signals = [sig("a", 40), sig("b", 35), sig("c", 30), sig("d", 15), sig("e", 15)];
    const score = computeScore(signals, { rating: 5, reviewCount: 5000, phone: "1" });
    expect(score).toBe(MAX_SCORE);
  });

  it("rounds to two decimals", () => {
    const score = computeScore(NO_WEBSITE, { reviewCount: 7, rating: 3.3 });
    expect(Math.round(score * 100) / 100).toBe(score);
  });
});

describe("computeScore: uncertain signals", () => {
  it("counts an uncertain signal at half weight", () => {
    expect(computeScore([sig("site_unreachable", 35, "UNCERTAIN")], {})).toBe(17.5);
  });

  it("scores a lead with a verified gap above the same gap seen only once", () => {
    const verified = computeScore([sig("site_unreachable", 35, "VERIFIED")], {});
    const uncertain = computeScore([sig("site_unreachable", 35, "UNCERTAIN")], {});
    expect(verified).toBeGreaterThan(uncertain);
  });

  it("scores zero-severity uncertain signals as no gap", () => {
    expect(computeScore([sig("site_not_checked", 0, "UNCERTAIN")], { phone: "1" })).toBe(0);
  });
});
