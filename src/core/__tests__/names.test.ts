import { describe, expect, it } from "vitest";
import { NameMatcher, type NamePattern } from "../names";

function pattern(text: string, sheetId: string, extra: Partial<NamePattern> = {}): NamePattern {
  return { text, sheetId, kind: "characters", ignoreCase: false, ...extra };
}

function found(matcher: NameMatcher, text: string): string[] {
  return matcher.find(text).map((m) => text.slice(m.from, m.to));
}

describe("NameMatcher", () => {
  const picard = [
    pattern("Jean-Luc Picard", "picard"),
    pattern("Picard", "picard"),
    pattern("Jean-Luc", "picard"),
    pattern("the Captain", "picard"),
  ];

  it("finds every name and alias", () => {
    const m = new NameMatcher(picard);
    expect(found(m, "Picard spoke. Jean-Luc listened, and the Captain agreed.")).toEqual([
      "Picard",
      "Jean-Luc",
      "the Captain",
    ]);
  });

  it("lets the longest match win", () => {
    const m = new NameMatcher([pattern("New York", "ny"), pattern("New York City", "nyc")]);
    const matches = m.find("She flew to New York City.");
    expect(matches).toHaveLength(1);
    expect(matches[0].sheetIds).toEqual(["nyc"]);
    expect(found(new NameMatcher(picard), "Jean-Luc Picard arrived.")).toEqual(["Jean-Luc Picard"]);
  });

  it("matches whole words only", () => {
    const m = new NameMatcher([pattern("Ann", "ann")]);
    expect(found(m, "Anna and Annabel met Ann.")).toEqual(["Ann"]);
  });

  it("treats straight and curly apostrophes as word edges", () => {
    const m = new NameMatcher([
      pattern("Arwen", "arwen"),
      pattern("Auberge", "auberge", { kind: "places" }),
    ]);
    expect(found(m, "Arwen's horse, Arwen’s cloak, d'Arwen, l’Auberge")).toEqual([
      "Arwen",
      "Arwen",
      "Arwen",
      "Auberge",
    ]);
  });

  it("matches decomposed text against a precomposed name", () => {
    const m = new NameMatcher([pattern("Zo\u00eb", "zoe")]);
    const text = "Zoe\u0308 waved.";
    const matches = m.find(text);
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0].from, matches[0].to)).toBe("Zoe\u0308");
  });

  it("matches precomposed text against a decomposed name", () => {
    const m = new NameMatcher([pattern("Zoe\u0308", "zoe")]);
    expect(found(m, "Zo\u00eb waved.")).toEqual(["Zo\u00eb"]);
  });

  it("keeps offsets right after decomposed characters earlier in the text", () => {
    const m = new NameMatcher([pattern("Elena", "elena")]);
    expect(found(m, "Cafe\u0301 talk with Elena.")).toEqual(["Elena"]);
  });

  it("is case-sensitive by default", () => {
    const m = new NameMatcher([pattern("Rose", "rose")]);
    expect(found(m, "Rose picked a rose.")).toEqual(["Rose"]);
  });

  it("lets an alias ignore case", () => {
    const m = new NameMatcher([pattern("the ferryman", "kell", { ignoreCase: true })]);
    expect(found(m, "The ferryman waited. So did THE FERRYMAN.")).toEqual([
      "The ferryman",
      "THE FERRYMAN",
    ]);
  });

  it("marks an alias shared by two sheets as ambiguous", () => {
    const m = new NameMatcher([pattern("Marie", "marie-a"), pattern("Marie", "marie-b")]);
    const [match] = m.find("Marie left.");
    expect(match.ambiguous).toBe(true);
    expect(match.sheetIds).toEqual(["marie-a", "marie-b"]);
  });

  it("handles names next to characters outside the BMP", () => {
    const m = new NameMatcher([pattern("Elena", "elena")]);
    expect(found(m, "\u{1F600}Elena\u{1F600}")).toEqual(["Elena"]);
  });

  it("ignores empty patterns and empty text", () => {
    const m = new NameMatcher([pattern("  ", "blank")]);
    expect(m.size).toBe(0);
    expect(m.find("anything")).toEqual([]);
    expect(new NameMatcher(picard).find("")).toEqual([]);
  });

  it("finds overlapping prefixes through failure links", () => {
    const m = new NameMatcher([pattern("Anna", "anna"), pattern("Annabel", "annabel"), pattern("bel", "bel")]);
    expect(found(m, "Annabel and Anna")).toEqual(["Annabel", "Anna"]);
  });
});

describe("ignored occurrences", () => {
  const rose = [pattern("Rose", "rose"), pattern("rose", "rose", { ignoreCase: true })];

  it("leaves out an occurrence ignored in its sentence, and only there", () => {
    const m = new NameMatcher(rose, [{ name: "rose", sentence: "She smelled the rose." }]);
    const text = "Rose left. She smelled the rose. Then a rose fell.";
    expect(found(m, text)).toEqual(["Rose", "rose"]);
    expect(m.find(text).map((x) => x.text)).toEqual(["Rose", "rose"]);
    expect(found(m, "She smelled the *rose*. ")).toEqual([]);
  });

  it("matches ignored names with curly or straight apostrophes alike", () => {
    const m = new NameMatcher([pattern("d'Arwen", "arwen")], [{ name: "d’Arwen", sentence: "Le livre d'Arwen." }]);
    expect(found(m, "Le livre d’Arwen.")).toEqual([]);
    expect(found(m, "Le livre d’Arwen est là.")).toEqual(["d’Arwen"]);
  });

  it("knows its names, with their case rules", () => {
    const m = new NameMatcher(rose.slice(0, 1).concat([pattern("the Captain", "c", { ignoreCase: true })]));
    expect(m.knows("Rose")).toBe(true);
    expect(m.knows("rose")).toBe(false);
    expect(m.knows("THE CAPTAIN")).toBe(true);
    expect(m.knows("Tomas")).toBe(false);
  });
});
