import { describe, expect, it } from "vitest";
import { NameMatcher } from "../names";
import { capitalizedWords, possibleNames } from "../possibleNames";

const matcher = new NameMatcher([{ text: "Elena", sheetId: "elena", kind: "characters", ignoreCase: false }]);
const words = (text: string) => Object.fromEntries(capitalizedWords(text, matcher));

describe("capitalizedWords", () => {
  it("counts capitalized words inside sentences only", () => {
    expect(words("Morning came. Then Tomas woke, and Tomas left with Ida.\n")).toEqual({ Tomas: 2, Ida: 1 });
  });

  it("skips the first word after dialogue marks and dashes", () => {
    expect(words("“Tomas,” said Ida. She said “Wait” and — Later — left. He said 'Come' to d'Arwen.")).toEqual({
      Ida: 1,
      Arwen: 1,
    });
  });

  it("leaves out names already highlighted, headings, scene breaks, titles and capitals alone", () => {
    expect(words("# The Lost City\n\nThey saw Elena and Mr. Kell. I said OK to TOMAS.\n\n* * *\n")).toEqual({ Kell: 1 });
    expect(words("Then Mr Kell came.")).toEqual({ Kell: 1 });
  });

  it("reads through Markdown emphasis and block quotes", () => {
    expect(words("> Then *Tomas* came, and **Ida**.")).toEqual({ Tomas: 1, Ida: 1 });
  });

  it("keeps hyphenated names whole and treats apostrophes as word edges", () => {
    expect(words("They met Jean-Luc at Tomas’s inn.")).toEqual({ "Jean-Luc": 1, Tomas: 1 });
  });
});

describe("possibleNames", () => {
  const chapters = [
    { chapterId: "one", words: new Map([["Tomas", 2], ["Ida", 1], ["Monday", 3]]) },
    { chapterId: "two", words: new Map([["Tomas", 1], ["Ida", 1]]) },
  ];

  it("offers words found often enough across the book, most often first", () => {
    expect(possibleNames(chapters, () => false)).toEqual([
      { word: "Monday", count: 3, chapterIds: ["one"] },
      { word: "Tomas", count: 3, chapterIds: ["one", "two"] },
    ]);
  });

  it("leaves out words already settled", () => {
    expect(possibleNames(chapters, (w) => w === "Monday").map((p) => p.word)).toEqual(["Tomas"]);
    expect(possibleNames(chapters, () => false, 2).map((p) => p.word)).toEqual(["Monday", "Tomas", "Ida"]);
  });
});
