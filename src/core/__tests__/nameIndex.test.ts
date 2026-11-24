import { describe, expect, it, vi } from "vitest";
import { countNames, NameIndex } from "../nameIndex";
import { NameMatcher, type NamePattern } from "../names";

function pattern(text: string, sheetId: string, extra: Partial<NamePattern> = {}): NamePattern {
  return { text, sheetId, kind: "characters", ignoreCase: false, ...extra };
}

const matcher = new NameMatcher([
  pattern("Elena", "elena"),
  pattern("Elena Voss", "elena"),
  pattern("Harbor Inn", "inn", { kind: "places" }),
  pattern("Marie", "marie-a"),
  pattern("Marie", "marie-b"),
]);

const one = { id: "manuscript/01 One.md", text: "# One\n\nElena Voss reached the Harbor Inn.\n\nElena slept.\n" };
const two = { id: "manuscript/02 Two.md", text: "# Two\n\nThe Harbor Inn was quiet. Marie waited.\n" };
const three = { id: "manuscript/03 Three.md", text: "# Three\n\nRain.\n" };

describe("countNames", () => {
  it("counts each sheet's names over every paragraph", () => {
    expect(countNames(one.text, matcher)).toEqual(new Map([["elena", 2], ["inn", 1]]));
  });

  it("counts a name shared by two sheets for both", () => {
    expect(countNames(two.text, matcher)).toEqual(new Map([["inn", 1], ["marie-a", 1], ["marie-b", 1]]));
  });

  it("finds nothing in a chapter without names", () => {
    expect(countNames(three.text, matcher).size).toBe(0);
  });
});

describe("NameIndex", () => {
  it("lists the chapters a sheet appears in, in the order given, with counts", () => {
    const index = new NameIndex();
    expect(index.appearances("inn", [two, one, three], matcher)).toEqual([
      { chapterId: two.id, count: 1 },
      { chapterId: one.id, count: 1 },
    ]);
    expect(index.appearances("elena", [one, two, three], matcher)).toEqual([{ chapterId: one.id, count: 2 }]);
    expect(index.appearances("nobody", [one, two, three], matcher)).toEqual([]);
  });

  it("scans only the chapter whose text changed", () => {
    const index = new NameIndex();
    const find = vi.spyOn(matcher, "find");
    index.appearances("elena", [one, two, three], matcher);
    const firstScan = find.mock.calls.length;
    expect(firstScan).toBeGreaterThan(0);

    index.appearances("inn", [one, two, three], matcher);
    expect(find.mock.calls.length).toBe(firstScan);

    const edited = { ...two, text: "# Two\n\nElena and Elena.\n" };
    expect(index.appearances("elena", [one, edited, three], matcher)).toEqual([
      { chapterId: one.id, count: 2 },
      { chapterId: edited.id, count: 2 },
    ]);
    // Only the edited chapter's lines were matched again.
    expect(find.mock.calls.slice(firstScan).map(([line]) => line)).toEqual(edited.text.split("\n"));
    find.mockRestore();
  });

  it("starts afresh with a new matcher", () => {
    const index = new NameIndex();
    expect(index.appearances("elena", [one], matcher)).toEqual([{ chapterId: one.id, count: 2 }]);
    const renamed = new NameMatcher([pattern("Voss", "elena")]);
    expect(index.appearances("elena", [one], renamed)).toEqual([{ chapterId: one.id, count: 1 }]);
    expect(index.counts(one, renamed)).toEqual(new Map([["elena", 1]]));
  });

  it("forgets chapters that are no longer in the book", () => {
    const index = new NameIndex();
    index.appearances("elena", [one, two], matcher);
    const find = vi.spyOn(matcher, "find");
    // Two was renamed: its old id is dropped, and the new id is scanned.
    const moved = { ...two, id: "manuscript/Part 1/02 Two.md" };
    index.appearances("inn", [one, moved], matcher);
    expect(find.mock.calls.map(([line]) => line)).toEqual(moved.text.split("\n"));
    find.mockClear();
    // Back under its old id, it is scanned again: nothing stale was kept.
    index.appearances("inn", [one, two], matcher);
    expect(find.mock.calls.map(([line]) => line)).toEqual(two.text.split("\n"));
    find.mockRestore();
  });

  it("shares a chapter's counts with the chapter view", () => {
    const index = new NameIndex();
    const counts = index.counts(one, matcher);
    expect(counts).toEqual(new Map([["elena", 2], ["inn", 1]]));
    expect(index.counts(one, matcher)).toBe(counts);
  });
});
