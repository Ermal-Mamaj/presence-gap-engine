import { describe, expect, it } from "vitest";
import type { WebsiteStatus } from "../src/lib/detect";
import {
  formatDuration,
  formatTimestamp,
  SCAN_STATUS_STYLE,
  WEBSITE_STATUS_HINT,
  WEBSITE_STATUS_LABEL,
  WEBSITE_STATUS_STYLE,
} from "../src/lib/display";

const ALL_STATUSES: WebsiteStatus[] = ["NONE_FOUND", "NEEDS_WORK", "NEEDS_CHECK", "GOOD"];

describe("website status presentation", () => {
  it("covers every WebsiteStatus, so the UI never renders an undefined label", () => {
    for (const status of ALL_STATUSES) {
      expect(WEBSITE_STATUS_LABEL[status]).toBeTruthy();
      expect(WEBSITE_STATUS_HINT[status]).toBeTruthy();
      expect(WEBSITE_STATUS_STYLE[status]).toBeTruthy();
    }
  });

  it("does not call an inconclusive check a verdict", () => {
    // NEEDS_CHECK means a request failed, not that the site is bad. The label
    // and hint must not imply a problem was established.
    expect(WEBSITE_STATUS_LABEL.NEEDS_CHECK.toLowerCase()).not.toMatch(/bad|broken|needs work/);
    expect(WEBSITE_STATUS_HINT.NEEDS_CHECK).toMatch(/nothing is proven/i);
  });

  it("says a missing website is the listing's, not the business's", () => {
    expect(WEBSITE_STATUS_HINT.NONE_FOUND).toMatch(/listing/i);
  });

  it("styles each scan status", () => {
    for (const status of ["RUNNING", "SUCCEEDED", "FAILED"]) {
      expect(SCAN_STATUS_STYLE[status]).toBeTruthy();
    }
  });
});

describe("formatDuration", () => {
  it("reports whole seconds", () => {
    expect(formatDuration("2026-10-10T21:55:00.000Z", "2026-10-10T21:55:05.000Z")).toBe("5s");
  });

  it("rounds to the nearest second", () => {
    expect(formatDuration("2026-10-10T21:55:00.000Z", "2026-10-10T21:55:04.600Z")).toBe("5s");
  });

  it("collapses sub-second runs rather than showing 0s", () => {
    expect(formatDuration("2026-10-10T21:55:00.000Z", "2026-10-10T21:55:00.400Z")).toBe("<1s");
  });

  it("has no duration for a run that never finished", () => {
    expect(formatDuration("2026-10-10T21:55:00.000Z", null)).toBe("—");
  });

  it("refuses a negative duration instead of printing one", () => {
    expect(formatDuration("2026-10-10T21:55:05.000Z", "2026-10-10T21:55:00.000Z")).toBe("—");
  });

  it("survives unparseable timestamps", () => {
    expect(formatDuration("not a date", "2026-10-10T21:55:00.000Z")).toBe("—");
    expect(formatDuration("2026-10-10T21:55:00.000Z", "not a date")).toBe("—");
  });
});

describe("formatTimestamp", () => {
  it("renders something for a valid timestamp", () => {
    const out = formatTimestamp("2026-10-10T21:55:00.000Z");
    expect(out).not.toBe("—");
    expect(out).toMatch(/2026/);
  });

  it("falls back for missing or unparseable input", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
    expect(formatTimestamp("")).toBe("—");
    expect(formatTimestamp("not a date")).toBe("—");
  });
});
