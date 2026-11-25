// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { paragraphMarks, SPELLING_MARK_CLASS } from "../editor/nameMarks";
import { NameMatcher } from "../names";
import {
  accepts,
  addToPersonalDictionary,
  parseWordList,
  readPersonalDictionary,
  spellingKey,
  withWordAdded,
  wordsToCheck,
} from "../spelling";

const words = (line: string, matcher = new NameMatcher([])) => wordsToCheck(line, matcher.find(line)).map((w) => w.word);

describe("the words of a paragraph to check", () => {
  it("takes words with their apostrophes and hyphens, at their place", () => {
    const line = "Elena’s cousin didn't see the sea-green door.";
    expect(words(line)).toEqual(["Elena’s", "cousin", "didn't", "see", "the", "sea-green", "door"]);
    const found = wordsToCheck(line);
    expect(found.map((w) => line.slice(w.from, w.to))).toEqual(found.map((w) => w.word));
  });

  it("leaves out names, single letters, numbers and words in capitals", () => {
    const matcher = new NameMatcher([{ text: "Arwen", sheetId: "a", kind: "characters", ignoreCase: false }]);
    expect(words("Arwen's horse saw d'Arwen and I at 3rd street, B12, NASA, OK.", matcher)).toEqual([
      "horse",
      "saw",
      "and",
      "at",
      "street",
    ]);
  });

  it("reads Markdown lines: markers and character references aren't words", () => {
    expect(words("# The *soaked* **bnoe**")).toEqual(["The", "soaked", "bnoe"]);
    expect(words("> Quoted&nbsp;words")).toEqual(["Quoted", "words"]);
    expect(words("***")).toEqual([]);
  });
});

describe("keys, word lists and dictionaries", () => {
  it("keys a word composed, with the typographic apostrophe", () => {
    expect(spellingKey("don't")).toBe("don’t");
    expect(spellingKey("Élodie".normalize("NFD"))).toBe("Élodie");
  });

  it("reads a dictionary file, leaving out blank lines and comments", () => {
    expect(parseWordList("Lowmere\n\n# invented\n  Varn  \r\nd'Arwen\n")).toEqual(["Lowmere", "Varn", "d’Arwen"]);
    expect(parseWordList(null)).toEqual([]);
  });

  it("adds a word as the file's last line, keeping the rest", () => {
    expect(withWordAdded(null, "Varn")).toBe("Varn\n");
    expect(withWordAdded("# mine\nLowmere", "Varn")).toBe("# mine\nLowmere\nVarn\n");
    expect(withWordAdded("Lowmere\n", "Varn")).toBe("Lowmere\nVarn\n");
  });

  it("accepts a word listed in lower case with a capital, not the other way", () => {
    const list = new Set(parseWordList("skiff\nLowmere\ndon't"));
    expect(accepts(list, "skiff")).toBe(true);
    expect(accepts(list, "Skiff")).toBe(true);
    expect(accepts(list, "Lowmere")).toBe(true);
    expect(accepts(list, "lowmere")).toBe(false);
    expect(accepts(list, "don’t")).toBe(true);
    expect(accepts(list, "Don't")).toBe(true);
  });
});

describe("the personal dictionary", () => {
  beforeEach(() => localStorage.clear());

  it("remembers words on this device, once each", () => {
    expect(readPersonalDictionary()).toEqual([]);
    addToPersonalDictionary("skiff");
    expect(addToPersonalDictionary("skiff")).toEqual(["skiff"]);
    addToPersonalDictionary("don't");
    expect(readPersonalDictionary()).toEqual(["skiff", "don’t"]);
  });

  it("starts empty when what is stored can't be read", () => {
    localStorage.setItem("writingTool.personalDictionary.v1", "{not json");
    expect(readPersonalDictionary()).toEqual([]);
  });
});

describe("spelling marks", () => {
  const matcher = new NameMatcher([{ text: "Elena", sheetId: "e", kind: "characters", ignoreCase: false }]);
  const classes = (text: string, misspelled: string[], suggestions: string[] = []) =>
    paragraphMarks(text, matcher, { misspelled: new Set(misspelled), suggestions: new Set(suggestions) }).map((m) => [
      text.slice(m.from, m.to),
      m.attributes.class.split(" ")[0],
    ]);

  it("marks misspelled words among names and possible names, in text order", () => {
    expect(classes("Elena saw teh boat and Mara by teh river.", ["teh"], ["Mara"])).toEqual([
      ["Elena", "name-mark"],
      ["teh", SPELLING_MARK_CLASS],
      ["Mara", "possible-name"],
      ["teh", SPELLING_MARK_CLASS],
    ]);
  });

  it("matches a word whatever its apostrophe", () => {
    expect(classes("She didnt' care, dont’ you see.", ["didnt", "dont"])).toEqual([
      ["didnt", SPELLING_MARK_CLASS],
      ["dont", SPELLING_MARK_CLASS],
    ]);
    expect(classes("I can't.", ["can’t"])).toEqual([["can't", SPELLING_MARK_CLASS]]);
  });

  it("never marks a name, even one the set holds", () => {
    expect(classes("Elena waits.", ["Elena"])).toEqual([["Elena", "name-mark"]]);
  });
});
