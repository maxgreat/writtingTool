import { describe, expect, it } from "vitest";
import { plainLine, sheetNoun } from "../sheets";

describe("plainLine", () => {
  it("removes Markdown markers", () => {
    expect(plainLine("> ## *Soaked* to the **bone**, _twice_")).toBe("Soaked to the bone, twice");
  });

  it("keeps underscores inside words", () => {
    expect(plainLine("Works at Smith_and_Sons, jane_doe_1@example.com")).toBe("Works at Smith_and_Sons, jane_doe_1@example.com");
  });
});

describe("sheetNoun", () => {
  it("names one sheet of the default types, and calls others sheets", () => {
    expect(["characters", "places", "notes", "creatures", "constructor"].map(sheetNoun)).toEqual([
      "character",
      "place",
      "note",
      "sheet",
      "sheet",
    ]);
  });
});
