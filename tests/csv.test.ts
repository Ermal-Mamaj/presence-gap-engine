import { describe, expect, it } from "vitest";
import { csvFilename, escapeCsvField, toCsv } from "@/lib/csv";

describe("escapeCsvField", () => {
  it("leaves a plain value alone", () => {
    expect(escapeCsvField("Clinica Dentare")).toBe("Clinica Dentare");
  });

  it("quotes a value containing a comma, so later columns don't shift", () => {
    expect(escapeCsvField("Rruga e Durresit 12, Tirana")).toBe('"Rruga e Durresit 12, Tirana"');
  });

  it("doubles inner quotes", () => {
    expect(escapeCsvField('The "Best" Cafe')).toBe('"The ""Best"" Cafe"');
  });

  it("quotes embedded newlines rather than ending the record", () => {
    expect(escapeCsvField("Line one\nLine two")).toBe('"Line one\nLine two"');
    expect(escapeCsvField("Line one\r\nLine two")).toBe('"Line one\r\nLine two"');
  });

  it("renders empty for null and undefined", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("emits finite numbers bare and drops non-finite ones", () => {
    expect(escapeCsvField(62.4)).toBe("62.4");
    expect(escapeCsvField(0)).toBe("0");
    expect(escapeCsvField(Number.NaN)).toBe("");
    expect(escapeCsvField(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("renders a date as ISO and an invalid date as empty", () => {
    expect(escapeCsvField(new Date("2026-10-10T21:55:00.000Z"))).toBe("2026-10-10T21:55:00.000Z");
    expect(escapeCsvField(new Date("nope"))).toBe("");
  });
});

describe("escapeCsvField: spreadsheet formula injection", () => {
  // OSM fields are editable by anyone and this export is opened in Excel or
  // Sheets, so a leading formula character must not survive as live syntax.
  it.each([
    ["=cmd|' /c calc'!A0", "'=cmd|' /c calc'!A0"],
    ["+1+cmd", "'+1+cmd"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1:A9)", "'@SUM(A1:A9)"],
  ])("neutralizes %s", (input, expected) => {
    expect(escapeCsvField(input)).toBe(expected);
  });

  it("neutralizes a leading tab or carriage return, which a spreadsheet strips first", () => {
    // The CR case also needs RFC 4180 quoting, so both guards apply.
    expect(escapeCsvField("\t=1+1")).toBe("'\t=1+1");
    expect(escapeCsvField("\r=1+1")).toBe('"\'\r=1+1"');
  });

  it("still guards a formula that also needs quoting", () => {
    expect(escapeCsvField('=HYPERLINK("http://x","go")')).toBe('"\'=HYPERLINK(""http://x"",""go"")"');
  });

  it("keeps a phone number as text, at the cost of a visible apostrophe", () => {
    // Excel shows the apostrophe when it opens a CSV. Without it, a compact
    // number opens as 3.56E+11 and loses its plus, which is worse.
    expect(escapeCsvField("+355 69 123 4567")).toBe("'+355 69 123 4567");
    expect(escapeCsvField("+355691234567")).toBe("'+355691234567");
  });

  it("does not touch a formula character that isn't leading", () => {
    expect(escapeCsvField("Smith=Jones Ltd")).toBe("Smith=Jones Ltd");
  });
});

describe("toCsv", () => {
  it("writes a header row and CRLF-delimited records ending in a newline", () => {
    const csv = toCsv(["name", "score"], [["Clinic", 62.4], ["Cafe, The", 10]]);
    expect(csv).toBe('name,score\r\nClinic,62.4\r\n"Cafe, The",10\r\n');
  });

  it("writes headers alone when there are no rows", () => {
    expect(toCsv(["name"], [])).toBe("name\r\n");
  });

  it("keeps column counts aligned when fields contain delimiters", () => {
    const csv = toCsv(["a", "b"], [['x,y"z', "plain"]]);
    const body = csv.trimEnd().split("\r\n")[1];
    // Three commas would mean the quoting failed and a column split.
    expect(body).toBe('"x,y""z",plain');
  });
});

describe("csvFilename", () => {
  it("slugifies a campaign name", () => {
    expect(csvFilename("Tirana dentists, no-website")).toBe("tirana-dentists-no-website-leads.csv");
  });

  it("strips characters that could break out of the Content-Disposition header", () => {
    // A quote or newline here would let the name inject a header.
    const name = 'evil"; DELETE=1\r\nX-Injected: yes';
    const out = csvFilename(name);
    expect(out).not.toMatch(/["\r\n;]/);
    expect(out.endsWith("-leads.csv")).toBe(true);
  });

  it("folds accents instead of dropping the word", () => {
    expect(csvFilename("Prishtinë kafe")).toBe("prishtine-kafe-leads.csv");
  });

  it("falls back when the name has no usable characters", () => {
    expect(csvFilename("!!!")).toBe("campaign-leads.csv");
    expect(csvFilename("")).toBe("campaign-leads.csv");
  });

  it("caps the length and leaves no trailing separator", () => {
    const out = csvFilename("a".repeat(200));
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).not.toMatch(/-+-leads\.csv$/);
  });
});
