import { describe, expect, it } from "vitest";
import { newSheetLabel, plainLine, sheetNoun } from "../sheets";

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

describe("newSheetLabel", () => {
  it("names the default types' sheets, and the group of others", () => {
    const type = (folder: string, label: string) => ({ folder, label, fields: [] });
    expect(newSheetLabel(type("characters", "Characters"))).toBe("New character");
    expect(newSheetLabel(type("notes", "Research"))).toBe("New note");
    expect(newSheetLabel(type("creatures", "Creatures"))).toBe("New sheet in Creatures");
    expect(newSheetLabel(type("constructor", "Constructor"))).toBe("New sheet in Constructor");
  });
});
