import { describe, expect, it } from "vitest";
import { MAX_PLACES, splitRegions } from "@/lib/regions";

describe("splitRegions", () => {
  it("is one place when there is no semicolon, commas and all", () => {
    expect(splitRegions("Suharekë, Kosovo")).toEqual(["Suharekë, Kosovo"]);
  });

  it("splits on semicolons and new lines, trimmed", () => {
    expect(splitRegions("Suharekë, Kosovo ; Rahovec, Kosovo;\n  Malishevë ,  Kosovo")).toEqual([
      "Suharekë, Kosovo",
      "Rahovec, Kosovo",
      "Malishevë , Kosovo",
    ]);
  });

  it("drops empties and a place named twice, however it is spelled", () => {
    expect(splitRegions("Suharekë, Kosovo;; ; suhareke, kosovo ;Rahovec")).toEqual(["Suharekë, Kosovo", "Rahovec"]);
  });

  it("is empty for a blank region", () => {
    expect(splitRegions("  ; ")).toEqual([]);
    expect(MAX_PLACES).toBe(5);
  });
});
